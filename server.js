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
    folder: 'poa_evidencias', 
    allowed_formats: ['jpg', 'png', 'jpeg', 'pdf'], 
    resource_type: 'auto' // <--- SOLO TIENES QUE AGREGAR ESTA LÍNEA
  },
});
const upload = multer({ storage: storage });


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

// --- OBTENER HISTORIAL DETALLADO ---
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

// --- GUARDAR REPORTE ---
// --- GUARDAR REPORTE (MODIFICADO PARA MÚLTIPLES ARCHIVOS) ---
// Cambiamos .single() por .array() permitiendo hasta 5 archivos
app.post('/api/reportar', upload.array('evidencia', 5), async (req, res) => {
    const { id_actividad, mes, avance_fisico, avance_financiero, observaciones, encargado, correo } = req.body;
    
    if (!id_actividad || !mes || !encargado || !correo) {
        return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }

    try {
        // 1. Verificación de Seguridad del Porcentaje
        const checkQuery = `SELECT COALESCE(SUM(avance_fisico_periodo), 0) as acumulado FROM REPORTES_AVANCE WHERE id_actividad = $1`;
        const checkResult = await pool.query(checkQuery, [id_actividad]);
        const avanceAcumulado = parseFloat(checkResult.rows[0].acumulado);
        const avanceNuevo = parseFloat(avance_fisico);

        if ((avanceAcumulado + avanceNuevo) > 100) {
            return res.status(400).json({ error: `Violación de límite. El avance total superaría el 100%. Te queda un máximo de ${100 - avanceAcumulado}% por reportar.` });
        }

        // AQUÍ ESTÁ EL CAMBIO PARA MÚLTIPLES IMÁGENES
        // req.files ahora es un arreglo con todos los archivos subidos
        // Mapeamos los archivos para obtener sus URLs de Cloudinary y las unimos separadas por comas
        let urls_evidencia = null;
        if (req.files && req.files.length > 0) {
            urls_evidencia = req.files.map(file => file.path).join(',');
        }

        // 3. Guardar en Base de Datos
        // NOTA: Como ahora urls_evidencia guarda varias URLs separadas por coma, asegúrate
        // que la columna 'url_evidencia_pdf' en tu base de datos Neon sea tipo TEXT (no un VARCHAR muy corto).
        const query = `
            INSERT INTO REPORTES_AVANCE 
            (id_actividad, mes_reportado, avance_fisico_periodo, avance_financiero_periodo, observaciones, url_evidencia_pdf, nombre_encargado, correo_contacto, estado_validacion)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'APROBADO')
            RETURNING id_reporte;
        `;
        const valores = [id_actividad, mes, avanceNuevo, avance_financiero, observaciones, urls_evidencia, encargado, correo];
        const respuesta = await pool.query(query, valores);

        res.json({ mensaje: 'Guardado correctamente', id: respuesta.rows[0].id_reporte });
    } catch (error) {
        console.error("Error al guardar:", error);
        res.status(500).json({ error: 'Error interno del servidor al intentar guardar' });
    }
});
// ==============================================================
// --- RUTAS EXCLUSIVAS DEL SUPER ADMIN ---
// ==============================================================

// 1. Borrar un reporte específico
app.delete('/api/superadmin/reporte/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM REPORTES_AVANCE WHERE id_reporte = $1', [id]);
        res.json({ exito: true, mensaje: 'Reporte borrado correctamente.' });
    } catch (error) {
        console.error("Error al borrar reporte:", error);
        res.status(500).json({ exito: false, mensaje: 'Error al borrar en la base de datos.' });
    }
});

// 2. Modificar presupuesto de un proyecto
app.put('/api/superadmin/presupuesto', async (req, res) => {
    try {
        const { codigo_proyecto, nuevo_presupuesto } = req.body;
        // Buscamos el ID del proyecto
        const getProy = await pool.query('SELECT id_proyecto FROM PROYECTOS WHERE codigo_proyecto = $1', [codigo_proyecto]);
        if(getProy.rows.length === 0) return res.status(404).json({exito: false, mensaje: 'Proyecto no encontrado'});
        
        const id_proyecto = getProy.rows[0].id_proyecto;
        // Actualizamos su presupuesto
        await pool.query('UPDATE ACTIVIDADES_PLANEADAS SET presupuesto_autorizado = $1 WHERE id_proyecto = $2', [nuevo_presupuesto, id_proyecto]);
        res.json({ exito: true, mensaje: 'Presupuesto actualizado exitosamente.' });
    } catch (error) {
        console.error("Error al modificar presupuesto:", error);
        res.status(500).json({ exito: false, mensaje: 'Error en la base de datos.' });
    }
});

// 3. Crear Departamento Nuevo
app.post('/api/superadmin/departamento', async (req, res) => {
    try {
        const { nombre } = req.body;
        // Busca el número máximo actual y le suma 1 para crear el ID
        const maxId = await pool.query('SELECT COALESCE(MAX(id_dependencia), 0) + 1 as nuevo_id FROM DEPARTAMENTOS');
        const nuevoId = maxId.rows[0].nuevo_id;
        
        await pool.query('INSERT INTO DEPARTAMENTOS (id_dependencia, nombre) VALUES ($1, $2)', [nuevoId, nombre]);
        res.json({ exito: true, mensaje: `Departamento "${nombre}" creado con éxito.` });
    } catch (error) {
        console.error("Error al crear departamento:", error);
        res.status(500).json({ exito: false, mensaje: 'Error en la base de datos.' });
    }
});

// 4. Crear Proyecto Nuevo Completo
app.post('/api/superadmin/proyecto', async (req, res) => {
    try {
        const { id_dependencia, codigo, nombre, presupuesto } = req.body;
        
        // 1. Buscamos una Meta General de ese departamento para anclarlo
        let meta = await pool.query("SELECT id_meta FROM METAS_GENERALES WHERE id_dependencia = $1 LIMIT 1", [id_dependencia]);
        let id_meta;
        
        // Si no tiene meta, le creamos una de emergencia
        if (meta.rows.length === 0) {
            const nuevaMeta = await pool.query(
                "INSERT INTO METAS_GENERALES (codigo_meta, descripcion, id_dependencia) VALUES ($1, $2, $3) RETURNING id_meta",
                [`${codigo}-GEN`, 'Meta generada por SuperAdmin', id_dependencia]
            );
            id_meta = nuevaMeta.rows[0].id_meta;
        } else {
            id_meta = meta.rows[0].id_meta;
        }

        // 2. Insertamos el Proyecto
        const proy = await pool.query(
            "INSERT INTO PROYECTOS (codigo_proyecto, nombre_proyecto, id_meta) VALUES ($1, $2, $3) RETURNING id_proyecto",
            [codigo, nombre, id_meta]
        );
        const id_proyecto = proy.rows[0].id_proyecto;

        // 3. Insertamos su Actividad y Presupuesto
        await pool.query(
            "INSERT INTO ACTIVIDADES_PLANEADAS (codigo_actividad, descripcion, presupuesto_autorizado, id_proyecto) VALUES ($1, $2, $3, $4)",
            [`${codigo}-ACT`, 'Ejecución general (SuperAdmin)', presupuesto, id_proyecto]
        );

        res.json({ exito: true, mensaje: `Proyecto ${codigo} creado y anclado correctamente.` });
    } catch (error) {
        console.error("Error al crear proyecto:", error);
        res.status(500).json({ exito: false, mensaje: 'Error, verifica que el código de proyecto no esté repetido.' });
    }
});
// 5. Borrar un Proyecto Completo (y todos sus reportes)
app.delete('/api/superadmin/proyecto/:codigo', async (req, res) => {
    try {
        const { codigo } = req.params;
        await pool.query(`
            DO $$
            DECLARE v_id_proyecto INT;
            BEGIN
                SELECT id_proyecto INTO v_id_proyecto FROM PROYECTOS WHERE codigo_proyecto = $1;
                IF v_id_proyecto IS NOT NULL THEN
                    DELETE FROM REPORTES_AVANCE WHERE id_actividad IN (SELECT id_actividad FROM ACTIVIDADES_PLANEADAS WHERE id_proyecto = v_id_proyecto);
                    DELETE FROM ACTIVIDADES_PLANEADAS WHERE id_proyecto = v_id_proyecto;
                    DELETE FROM PROYECTOS WHERE id_proyecto = v_id_proyecto;
                END IF;
            END $$;
        `, [codigo]);
        res.json({ exito: true, mensaje: 'Proyecto y todos sus reportes eliminados correctamente.' });
    } catch (error) {
        console.error("Error al borrar proyecto:", error);
        res.status(500).json({ exito: false, mensaje: 'Error al borrar proyecto en la base de datos.' });
    }
});

// 6. Borrar un Departamento Completo (y todos sus proyectos y reportes)
app.delete('/api/superadmin/departamento/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query(`
            DO $$
            BEGIN
                DELETE FROM REPORTES_AVANCE WHERE id_actividad IN (SELECT a.id_actividad FROM ACTIVIDADES_PLANEADAS a JOIN PROYECTOS p ON a.id_proyecto = p.id_proyecto JOIN METAS_GENERALES m ON p.id_meta = m.id_meta WHERE m.id_dependencia = $1);
                DELETE FROM ACTIVIDADES_PLANEADAS WHERE id_proyecto IN (SELECT p.id_proyecto FROM PROYECTOS p JOIN METAS_GENERALES m ON p.id_meta = m.id_meta WHERE m.id_dependencia = $1);
                DELETE FROM PROYECTOS WHERE id_meta IN (SELECT id_meta FROM METAS_GENERALES WHERE id_dependencia = $1);
                DELETE FROM METAS_GENERALES WHERE id_dependencia = $1;
                DELETE FROM DEPARTAMENTOS WHERE id_dependencia = $1;
            END $$;
        `, [id]);
        res.json({ exito: true, mensaje: 'Departamento, metas, proyectos y reportes eliminados para siempre.' });
    } catch (error) {
        console.error("Error al borrar departamento:", error);
        res.status(500).json({ exito: false, mensaje: 'Error al borrar departamento en la base de datos.' });
    }
});

// 4. ENCENDER SERVIDOR
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(` Servidor POA corriendo en puerto ${port}`);
});