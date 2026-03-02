const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();

// 1. CONFIGURACIÓN DE SEGURIDAD Y ARCHIVOS
app.use(cors());
app.use(express.json());

// Decirle al servidor que sirva los archivos HTML de la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// --- NUEVA CONFIGURACIÓN DE NUBE (CLOUDINARY) ---
cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
  api_key: process.env.CLOUDINARY_API_KEY, 
  api_secret: process.env.CLOUDINARY_API_SECRET 
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'poa_evidencias', // Carpeta donde se guardarán en tu nube
    allowed_formats: ['jpg', 'png', 'jpeg', 'pdf'] // Tipos de archivo permitidos
  },
});
const upload = multer({ storage: storage });
// (Eliminamos app.use('/uploads'...) porque ya no usamos la carpeta local)


// 2. CONEXIÓN A BASE DE DATOS
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:admin@localhost:5432/poa_db',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// 3. RUTAS DEL SISTEMA

// ---> Redireccionar la entrada principal al Login <---
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

// --- LOGIN ---
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const resultado = await pool.query(
            'SELECT id_usuario, nombre_completo, rol, id_dependencia FROM USUARIOS WHERE email = $1 AND password = $2',
            [email, password]
        );

        if (resultado.rows.length > 0) {
            res.json({ exito: true, usuario: resultado.rows[0] });
        } else {
            res.status(401).json({ exito: false, mensaje: 'Credenciales incorrectas' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).send('Error en login');
    }
});

// --- DATOS TABLERO PRINCIPAL ---
app.get('/api/tablero', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM VISTA_TABLERO_CONTROL');
    res.json(resultado.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error de BD');
  }
});

// --- DATOS PRESIDENCIA ---
app.get('/api/presidencia', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM VISTA_GENERAL_PRESIDENCIA');
        res.json(resultado.rows);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error obteniendo datos presidenciales');
    }
});

// --- Obtener lista de Departamentos ---
app.get('/api/departamentos', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT id_dependencia, nombre FROM CAT_DEPENDENCIAS ORDER BY nombre');
        res.json(resultado.rows);
    } catch (error) { res.status(500).send('Error'); }
});

// --- Obtener Proyectos (Calcula Avance Físico Acumulado) ---
app.get('/api/actividades/:id_dep', async (req, res) => {
    try {
        const { id_dep } = req.params;
        const query = `
            SELECT a.id_actividad, p.codigo_proyecto, p.nombre_proyecto, a.presupuesto_autorizado,
                   (SELECT COALESCE(SUM(avance_financiero_periodo), 0) FROM REPORTES_AVANCE r WHERE r.id_actividad = a.id_actividad) as gastado,
                   (SELECT COALESCE(SUM(avance_fisico_periodo), 0) FROM REPORTES_AVANCE r WHERE r.id_actividad = a.id_actividad) as fisico_acumulado
            FROM ACTIVIDADES_PLANEADAS a
            JOIN PROYECTOS p ON a.id_proyecto = p.id_proyecto
            JOIN METAS_GENERALES m ON p.id_meta = m.id_meta
            WHERE m.id_dependencia = $1
        `;
        const resultado = await pool.query(query, [id_dep]);
        res.json(resultado.rows);
    } catch (error) { res.status(500).send('Error'); }
});

// --- OBTENER HISTORIAL DETALLADO (CORREGIDO Y BLINDADO) ---
app.get('/api/historial/:codigo', async (req, res) => {
    try {
        const { codigo } = req.params;
        const query = `
            SELECT r.id_reporte, r.mes_reportado, r.avance_fisico_periodo, r.avance_financiero_periodo, 
                   r.observaciones, r.url_evidencia_pdf, r.nombre_encargado, r.correo_contacto, 
                   TO_CHAR(r.fecha_registro, 'DD/MM/YYYY a las HH24:MI') as fecha_exacta
            FROM REPORTES_AVANCE r
            JOIN ACTIVIDADES_PLANEADAS a ON r.id_actividad = a.id_actividad
            JOIN PROYECTOS p ON a.id_proyecto = p.id_proyecto
            WHERE p.codigo_proyecto = $1
            ORDER BY r.fecha_registro DESC;
        `;
        const resultado = await pool.query(query, [codigo]);
        res.json(resultado.rows);
    } catch (error) { 
        console.error("Error al obtener historial:", error);
        res.status(500).send('Error en historial'); 
    }
});

// --- GUARDAR REPORTE (CON PROTECCIÓN ESTRICTA MATEMÁTICA Y CLOUDINARY) ---
app.post('/api/reportar', upload.single('evidencia'), async (req, res) => {
    const { id_actividad, mes, avance_fisico, avance_financiero, observaciones, encargado, correo } = req.body;
    
    if (!id_actividad || !mes || !encargado || !correo) {
        return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }

    try {
        // 1. Verificación de Seguridad: Candado en el backend
        const checkQuery = `SELECT COALESCE(SUM(avance_fisico_periodo), 0) as acumulado FROM REPORTES_AVANCE WHERE id_actividad = $1`;
        const checkResult = await pool.query(checkQuery, [id_actividad]);
        const avanceAcumulado = parseFloat(checkResult.rows[0].acumulado);
        const avanceNuevo = parseFloat(avance_fisico);

        if ((avanceAcumulado + avanceNuevo) > 100) {
            return res.status(400).json({ error: `Violación de límite. El avance total superaría el 100%. Te queda un máximo de ${100 - avanceAcumulado}% por reportar.` });
        }

        // AQUÍ EL CAMBIO CLAVE: Tomamos la URL segura y permanente que nos devuelve Cloudinary
        const url_evidencia = req.file ? req.file.path : null;

        const query = `
            INSERT INTO REPORTES_AVANCE 
            (id_actividad, mes_reportado, avance_fisico_periodo, avance_financiero_periodo, observaciones, url_evidencia_pdf, nombre_encargado, correo_contacto, estado_validacion)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'APROBADO')
            RETURNING id_reporte;
        `;
        const valores = [id_actividad, mes, avanceNuevo, avance_financiero, observaciones, url_evidencia, encargado, correo];
        const respuesta = await pool.query(query, valores);

        res.json({ mensaje: 'Guardado correctamente', id: respuesta.rows[0].id_reporte });
    } catch (error) {
        console.error("Error al guardar:", error);
        res.status(500).json({ error: 'Error interno del servidor al intentar guardar' });
    }
});

// --- RETROALIMENTACIÓN (ADMIN) ---
app.post('/api/retroalimentar', async (req, res) => {
    const { id_reporte, mensaje, estado } = req.body;
    try {
        res.json({ exito: true, mensaje: 'Función en construcción (Backend listo)' });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error guardando feedback');
    }
});

// 4. ENCENDER SERVIDOR
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(` Servidor POA corriendo en puerto ${port}`);
});