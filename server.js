require('dotenv').config();
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
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURACIÓN DE NUBE (CLOUDINARY) ---
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
    resource_type: 'auto',
    transformation: [
      { width: 1280, crop: 'limit' }, 
      { quality: 'auto', fetch_format: 'auto' }
    ]
  },
});
const upload = multer({ storage: storage });

// 2. CONEXIÓN A BASE DE DATOS
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:admin@localhost:5432/poa_db',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.on('error', (err, client) => {
  console.error('Error inesperado en segundo plano con PostgreSQL:', err);
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('Error al intentar conectar con la base de datos:', err.stack);
  } else {
    console.log('¡Conexión exitosa a la base de datos PostgreSQL!');
    release(); 
  }
});

// 3. RUTAS DEL SISTEMA
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

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

app.get('/api/tablero', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM VISTA_TABLERO_CONTROL');
    res.json(resultado.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error de BD');
  }
});

app.get('/api/presidencia', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM VISTA_GENERAL_PRESIDENCIA');
        res.json(resultado.rows);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error obteniendo datos presidenciales');
    }
});

app.get('/api/departamentos', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT id_dependencia, nombre FROM CAT_DEPENDENCIAS ORDER BY nombre');
        res.json(resultado.rows);
    } catch (error) { res.status(500).send('Error'); }
});

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

app.post('/api/reportar', upload.array('evidencia', 10), async (req, res) => {
    const { id_actividad, mes, avance_fisico, avance_financiero, observaciones, encargado, correo } = req.body;
    if (!id_actividad || !mes || !encargado || !correo) return res.status(400).json({ error: 'Faltan datos obligatorios' });

    try {
        const checkQuery = `SELECT COALESCE(SUM(avance_fisico_periodo), 0) as acumulado FROM REPORTES_AVANCE WHERE id_actividad = $1`;
        const checkResult = await pool.query(checkQuery, [id_actividad]);
        const avanceAcumulado = parseFloat(checkResult.rows[0].acumulado);
        const avanceNuevo = parseFloat(avance_fisico);
        const gastoNuevo = parseFloat(avance_financiero);

        if (isNaN(avanceNuevo) || avanceNuevo < 0) {
            return res.status(400).json({ error: 'El avance físico no puede ser un número negativo.' });
        }
        if (isNaN(gastoNuevo) || gastoNuevo < 0) {
            return res.status(400).json({ error: 'El gasto reportado no puede ser un número negativo.' });
        }

        if ((avanceAcumulado + avanceNuevo) > 100) {
            return res.status(400).json({ error: `Violación de límite. El avance total superaría el 100%. Te queda un máximo de ${100 - avanceAcumulado}% por reportar.` });
        }

        let urls_evidencia = null;
        if (req.files && req.files.length > 0) urls_evidencia = req.files.map(file => file.path).join(',');

        const query = `
            INSERT INTO REPORTES_AVANCE 
            (id_actividad, mes_reportado, avance_fisico_periodo, avance_financiero_periodo, observaciones, url_evidencia_pdf, nombre_encargado, correo_contacto, estado_validacion)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'APROBADO')
            RETURNING id_reporte;
        `;
        const valores = [id_actividad, mes, avanceNuevo, gastoNuevo, observaciones, urls_evidencia, encargado, correo];
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

app.put('/api/superadmin/reporte/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { avance_fisico, avance_financiero } = req.body;
        await pool.query(
            'UPDATE reportes_avance SET avance_fisico_periodo = $1, avance_financiero_periodo = $2 WHERE id_reporte = $3',
            [avance_fisico, avance_financiero, id]
        );
        res.json({ exito: true, mensaje: 'Avance actualizado correctamente. El total del proyecto cambiará.' });
    } catch (error) {
        console.error("Error al actualizar reporte:", error);
        res.status(500).json({ exito: false, mensaje: 'Error al actualizar el avance en la base de datos.' });
    }
});

app.put('/api/superadmin/presupuesto', async (req, res) => {
    try {
        const { codigo_proyecto, nuevo_presupuesto } = req.body;
        const getProy = await pool.query('SELECT id_proyecto FROM PROYECTOS WHERE codigo_proyecto = $1', [codigo_proyecto]);
        if(getProy.rows.length === 0) return res.status(404).json({exito: false, mensaje: 'Proyecto no encontrado'});
        
        const id_proyecto = getProy.rows[0].id_proyecto;
        await pool.query('UPDATE ACTIVIDADES_PLANEADAS SET presupuesto_autorizado = $1 WHERE id_proyecto = $2', [nuevo_presupuesto, id_proyecto]);
        res.json({ exito: true, mensaje: 'Presupuesto actualizado exitosamente.' });
    } catch (error) {
        console.error("Error al modificar presupuesto:", error);
        res.status(500).json({ exito: false, mensaje: 'Error en la base de datos.' });
    }
});

app.post('/api/superadmin/departamento', async (req, res) => {
    try {
        const { nombre } = req.body;
        const maxId = await pool.query('SELECT COALESCE(MAX(id_dependencia), 0) + 1 as nuevo_id FROM departamentos');
        const nuevoId = maxId.rows[0].nuevo_id;
        await pool.query('INSERT INTO departamentos (id_dependencia, nombre) VALUES ($1, $2)', [nuevoId, nombre]);
        res.json({ exito: true, mensaje: `Departamento "${nombre}" creado con éxito.` });
    } catch (error) {
        console.error("Error al crear departamento:", error);
        res.status(500).json({ exito: false, mensaje: 'Error en la base de datos.' });
    }
});

app.post('/api/superadmin/proyecto', async (req, res) => {
    try {
        const { id_dependencia, codigo, nombre, presupuesto } = req.body;
        let meta = await pool.query("SELECT id_meta FROM METAS_GENERALES WHERE id_dependencia = $1 LIMIT 1", [id_dependencia]);
        let id_meta;
        
        if (meta.rows.length === 0) {
            const nuevaMeta = await pool.query(
                "INSERT INTO METAS_GENERALES (codigo_meta, descripcion, id_dependencia) VALUES ($1, $2, $3) RETURNING id_meta",
                [`${codigo}-GEN`, 'Meta generada por SuperAdmin', id_dependencia]
            );
            id_meta = nuevaMeta.rows[0].id_meta;
        } else {
            id_meta = meta.rows[0].id_meta;
        }

        const proy = await pool.query(
            "INSERT INTO PROYECTOS (codigo_proyecto, nombre_proyecto, id_meta) VALUES ($1, $2, $3) RETURNING id_proyecto",
            [codigo, nombre, id_meta]
        );
        const id_proyecto = proy.rows[0].id_proyecto;

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

app.delete('/api/superadmin/proyecto/:codigo', async (req, res) => {
    const client = await pool.connect(); 
    try {
        const { codigo } = req.params;
        await client.query('BEGIN'); 
        const proyRes = await client.query('SELECT id_proyecto FROM PROYECTOS WHERE codigo_proyecto = $1', [codigo]);
        
        if (proyRes.rows.length > 0) {
            const id_proyecto = proyRes.rows[0].id_proyecto;
            await client.query('DELETE FROM REPORTES_AVANCE WHERE id_actividad IN (SELECT id_actividad FROM ACTIVIDADES_PLANEADAS WHERE id_proyecto = $1)', [id_proyecto]);
            await client.query('DELETE FROM ACTIVIDADES_PLANEADAS WHERE id_proyecto = $1', [id_proyecto]);
            await client.query('DELETE FROM PROYECTOS WHERE id_proyecto = $1', [id_proyecto]);
        }
        await client.query('COMMIT'); 
        res.json({ exito: true, mensaje: 'Proyecto y todos sus reportes eliminados correctamente.' });
    } catch (error) {
        await client.query('ROLLBACK'); 
        console.error("Error al borrar proyecto:", error);
        res.status(500).json({ exito: false, mensaje: 'Error al borrar proyecto en la base de datos.' });
    } finally {
        client.release(); 
    }
});

app.delete('/api/superadmin/departamento/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        await client.query('BEGIN'); 

        await client.query(`
            DELETE FROM reportes_avance WHERE id_actividad IN (
                SELECT a.id_actividad FROM actividades_planeadas a 
                JOIN proyectos p ON a.id_proyecto = p.id_proyecto 
                JOIN metas_generales m ON p.id_meta = m.id_meta 
                WHERE m.id_dependencia = $1
            )`, [id]);

        await client.query(`
            DELETE FROM actividades_planeadas WHERE id_proyecto IN (
                SELECT p.id_proyecto FROM proyectos p 
                JOIN metas_generales m ON p.id_meta = m.id_meta 
                WHERE m.id_dependencia = $1
            )`, [id]);

        await client.query(`DELETE FROM proyectos WHERE id_meta IN (SELECT id_meta FROM metas_generales WHERE id_dependencia = $1)`, [id]);
        await client.query(`DELETE FROM metas_generales WHERE id_dependencia = $1`, [id]);
        await client.query(`DELETE FROM departamentos WHERE id_dependencia = $1`, [id]); 

        await client.query('COMMIT'); 
        res.json({ exito: true, mensaje: 'Departamento, metas, proyectos y reportes eliminados para siempre.' });
    } catch (error) {
        await client.query('ROLLBACK'); 
        console.error("Error al borrar departamento:", error);
        res.status(500).json({ exito: false, mensaje: 'Error al borrar departamento en la base de datos.' });
    } finally {
        client.release(); 
    }
});


// Qué resuelve:
//  - /api/comparativo-departamentos  -> Presupuesto vs. Gastado de TODAS
//    las dependencias (para la vista comparativa que pidió el cliente).
//  - /api/reporte-departamento/:id_dep -> Resumen mensual completo de
//    UNA dependencia: acciones realizadas, gasto, avance físico y
//    evidencias, mes por mes, con acumulados e indicador de semáforo.
//
// Nota sobre "mes_reportado": en la tabla REPORTES_AVANCE se guarda como
// texto ("Enero", "Febrero", ...), no como fecha. Por eso el orden
// cronológico se hace con un CASE en vez de ORDER BY directo.

const ORDEN_MESES_CASE = `
    CASE r.mes_reportado
        WHEN 'Enero' THEN 1 WHEN 'Febrero' THEN 2 WHEN 'Marzo' THEN 3
        WHEN 'Abril' THEN 4 WHEN 'Mayo' THEN 5 WHEN 'Junio' THEN 6
        WHEN 'Julio' THEN 7 WHEN 'Agosto' THEN 8 WHEN 'Septiembre' THEN 9
        WHEN 'Octubre' THEN 10 WHEN 'Noviembre' THEN 11 WHEN 'Diciembre' THEN 12
        ELSE 99 END
`;

// --- Calcula el semáforo de ejecución presupuestal ---
// Supuesto (ajustable): el gasto debería avanzar aprox. lineal a lo largo
// de 12 meses. Si llevan reportados N meses, se "esperaría" haber
// ejercido N/12 del presupuesto. Se compara contra lo realmente ejercido.
function calcularSemaforo(pctEjecutado, mesesConReporte) {
    const meses = mesesConReporte > 0 ? mesesConReporte : 1;
    const esperado = (meses / 12) * 100;
    const diferencia = pctEjecutado - esperado;
    // diferencia > 0  -> va POR ARRIBA de lo esperado
    // diferencia < 0  -> va POR ABAJO de lo esperado
    const base = { avance_esperado: parseFloat(esperado.toFixed(1)), diferencia: parseFloat(diferencia.toFixed(1)) };

    if (diferencia >= -10 && diferencia <= 25) {
        return { color: 'verde', mensaje: 'Ejecución acorde a lo esperado', ...base };
    }
    if (diferencia < -10 && diferencia >= -25) {
        return { color: 'amarillo', mensaje: 'Por debajo de lo esperado (subejercicio moderado)', ...base };
    }
    if (diferencia < -25) {
        return { color: 'rojo', mensaje: 'Subejercicio significativo vs. lo presupuestado', ...base };
    }
    return { color: 'rojo', mensaje: 'Sobre-ejercicio muy por encima de lo esperado', ...base };
}

// ==============================================================
// 1. COMPARATIVO DE TODAS LAS DEPENDENCIAS
//    (Presupuesto autorizado vs. gastado, con avance físico promedio)
// ==============================================================
app.get('/api/comparativo-departamentos', async (req, res) => {
    try {
        const query = `
            WITH presupuesto_dep AS (
                SELECT m.id_dependencia, SUM(a.presupuesto_autorizado) as presupuesto_autorizado
                FROM ACTIVIDADES_PLANEADAS a
                JOIN PROYECTOS p ON a.id_proyecto = p.id_proyecto
                JOIN METAS_GENERALES m ON p.id_meta = m.id_meta
                GROUP BY m.id_dependencia
            ),
            avance_dep AS (
                SELECT m.id_dependencia,
                       COALESCE(SUM(r.avance_financiero_periodo), 0) as gasto_acumulado,
                       COALESCE(AVG(r.avance_fisico_periodo), 0) as avance_fisico_promedio,
                       COUNT(r.id_reporte) as acciones_reportadas,
                       COUNT(DISTINCT r.mes_reportado) as meses_con_reporte
                FROM REPORTES_AVANCE r
                JOIN ACTIVIDADES_PLANEADAS a ON r.id_actividad = a.id_actividad
                JOIN PROYECTOS p ON a.id_proyecto = p.id_proyecto
                JOIN METAS_GENERALES m ON p.id_meta = m.id_meta
                GROUP BY m.id_dependencia
            )
            SELECT
                d.id_dependencia,
                d.nombre,
                COALESCE(pd.presupuesto_autorizado, 0) as presupuesto_autorizado,
                COALESCE(ad.gasto_acumulado, 0) as gasto_acumulado,
                COALESCE(ad.avance_fisico_promedio, 0) as avance_fisico_promedio,
                COALESCE(ad.acciones_reportadas, 0) as acciones_reportadas,
                COALESCE(ad.meses_con_reporte, 0) as meses_con_reporte
            FROM CAT_DEPENDENCIAS d
            LEFT JOIN presupuesto_dep pd ON pd.id_dependencia = d.id_dependencia
            LEFT JOIN avance_dep ad ON ad.id_dependencia = d.id_dependencia
            ORDER BY d.nombre;
        `;
        const resultado = await pool.query(query);

        const filas = resultado.rows.map(row => {
            const presupuesto = parseFloat(row.presupuesto_autorizado);
            const gasto = parseFloat(row.gasto_acumulado);
            const pctEjecutado = presupuesto > 0 ? (gasto / presupuesto) * 100 : 0;
            return {
                ...row,
                presupuesto_autorizado: presupuesto,
                gasto_acumulado: gasto,
                brecha: presupuesto - gasto,
                pct_ejecutado: parseFloat(pctEjecutado.toFixed(2)),
                avance_fisico_promedio: parseFloat(parseFloat(row.avance_fisico_promedio).toFixed(2)),
                semaforo: calcularSemaforo(pctEjecutado, parseInt(row.meses_con_reporte))
            };
        });

        res.json(filas);
    } catch (error) {
        console.error("Error en comparativo de departamentos:", error);
        res.status(500).send('Error al generar el comparativo de departamentos');
    }
});

// ==============================================================
// 2. REPORTE MENSUAL DETALLADO DE UN DEPARTAMENTO
//    Acciones realizadas, gasto, avance físico y evidencias por mes
// ==============================================================
app.get('/api/reporte-departamento/:id_dep', async (req, res) => {
    try {
        const { id_dep } = req.params;

        // --- Presupuesto total autorizado del departamento ---
        const presupuestoQ = await pool.query(`
            SELECT COALESCE(SUM(a.presupuesto_autorizado), 0) as total
            FROM ACTIVIDADES_PLANEADAS a
            JOIN PROYECTOS p ON a.id_proyecto = p.id_proyecto
            JOIN METAS_GENERALES m ON p.id_meta = m.id_meta
            WHERE m.id_dependencia = $1
        `, [id_dep]);
        const presupuesto_autorizado = parseFloat(presupuestoQ.rows[0].total);

        // --- Resumen por mes, con avance físico acumulado calculado
        //     por proyecto (suma corrida) y luego promediado entre
        //     los proyectos del departamento ---
        const resumenMesQ = await pool.query(`
            WITH datos AS (
                SELECT
                    p.id_proyecto,
                    r.mes_reportado,
                    ${ORDEN_MESES_CASE} as num_mes,
                    r.avance_fisico_periodo,
                    r.avance_financiero_periodo
                FROM REPORTES_AVANCE r
                JOIN ACTIVIDADES_PLANEADAS a ON r.id_actividad = a.id_actividad
                JOIN PROYECTOS p ON a.id_proyecto = p.id_proyecto
                JOIN METAS_GENERALES m ON p.id_meta = m.id_meta
                WHERE m.id_dependencia = $1
            ),
            acumulado AS (
                SELECT *,
                    SUM(avance_fisico_periodo) OVER (PARTITION BY id_proyecto ORDER BY num_mes) as avance_acum_proyecto
                FROM datos
            )
            SELECT
                mes_reportado as mes,
                num_mes,
                COUNT(*) as acciones_reportadas,
                COALESCE(SUM(avance_financiero_periodo), 0) as gasto_periodo,
                COALESCE(AVG(avance_fisico_periodo), 0) as avance_fisico_periodo_promedio,
                COALESCE(AVG(avance_acum_proyecto), 0) as avance_fisico_acumulado_promedio
            FROM acumulado
            GROUP BY mes_reportado, num_mes
            ORDER BY num_mes;
        `, [id_dep]);

        // --- Detalle de acciones + evidencias, mes por mes ---
        const detalleQ = await pool.query(`
            SELECT
                r.mes_reportado as mes,
                p.codigo_proyecto,
                p.nombre_proyecto,
                r.avance_fisico_periodo,
                r.avance_financiero_periodo,
                r.observaciones,
                r.url_evidencia_pdf,
                r.nombre_encargado,
                TO_CHAR(r.fecha_registro, 'DD/MM/YYYY') as fecha
            FROM REPORTES_AVANCE r
            JOIN ACTIVIDADES_PLANEADAS a ON r.id_actividad = a.id_actividad
            JOIN PROYECTOS p ON a.id_proyecto = p.id_proyecto
            JOIN METAS_GENERALES m ON p.id_meta = m.id_meta
            WHERE m.id_dependencia = $1
            ORDER BY ${ORDEN_MESES_CASE}, p.codigo_proyecto;
        `, [id_dep]);

        // --- Acumular el gasto mes a mes (el dinero sí se puede sumar
        //     directamente entre proyectos, a diferencia del % de avance) ---
        let gastoAcumulado = 0;
        const resumen_por_mes = resumenMesQ.rows.map(row => {
            gastoAcumulado += parseFloat(row.gasto_periodo);
            return {
                mes: row.mes,
                acciones_reportadas: parseInt(row.acciones_reportadas),
                gasto_periodo: parseFloat(row.gasto_periodo),
                gasto_acumulado: gastoAcumulado,
                avance_fisico_periodo_promedio: parseFloat(parseFloat(row.avance_fisico_periodo_promedio).toFixed(2)),
                avance_fisico_acumulado_promedio: parseFloat(parseFloat(row.avance_fisico_acumulado_promedio).toFixed(2))
            };
        });

        const gasto_acumulado_total = gastoAcumulado;
        const pct_ejecutado = presupuesto_autorizado > 0 ? (gasto_acumulado_total / presupuesto_autorizado) * 100 : 0;
        const avance_fisico_promedio_general = resumen_por_mes.length > 0
            ? resumen_por_mes[resumen_por_mes.length - 1].avance_fisico_acumulado_promedio
            : 0;

        res.json({
            presupuesto_autorizado,
            gasto_acumulado: gasto_acumulado_total,
            brecha: presupuesto_autorizado - gasto_acumulado_total,
            pct_ejecutado: parseFloat(pct_ejecutado.toFixed(2)),
            avance_fisico_promedio: avance_fisico_promedio_general,
            semaforo: calcularSemaforo(pct_ejecutado, resumen_por_mes.length),
            resumen_por_mes,
            detalle: detalleQ.rows
        });
    } catch (error) {
        console.error("Error al generar reporte de departamento:", error);
        res.status(500).send('Error al generar el reporte del departamento');
    }
});



// 4. ENCENDER SERVIDOR
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor POA corriendo en puerto ${port}`);
});