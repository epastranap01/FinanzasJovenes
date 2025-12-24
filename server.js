require('dotenv').config(); // Cargar variables de entorno
const express = require('express');
const { Pool } = require('pg'); // <--- AQUÍ ESTÁ EL CAMBIO: Usamos 'pg'
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Configuración de Sesión
app.use(session({
    secret: 'SuperSecretoJovenes2025',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 3600000 } 
}));

app.use(express.static('public'));

// Conexión a Base de Datos (Nube - Neon)
// Busca la URL en el archivo .env
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Requerido para Neon.tech
});

pool.connect()
    .then(() => console.log('✅ Conectado a PostgreSQL en la Nube'))
    .catch(err => console.error('❌ Error de conexión:', err));

// --- MIDDLEWARE DE PROTECCIÓN MEJORADO ---
const protect = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }

    // Si el usuario es 'viewer' y trata de hacer algo que no sea VER (GET), lo rebotamos
    if (req.method !== 'GET' && req.session.user.rol === 'viewer') {
        return res.status(403).json({ 
            success: false, 
            message: 'Acceso denegado: Tu usuario es de solo lectura.' 
        });
    }
    
    next();
};

// --- RUTAS API (Adaptadas a Postgres) ---

// Actualiza la ruta de login para que guarde el rol en la sesión
app.post('/api/login', async (req, res) => {
    try {
        const { usuario, password } = req.body;
        const result = await pool.query('SELECT id, usuario, nombre, rol FROM usuarios WHERE usuario = $1 AND password = $2', [usuario, password]);
        
        if (result.rows.length > 0) {
            req.session.user = result.rows[0]; // Aquí ya se guarda el rol
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false });
        }
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/session', (req, res) => {
    res.json({ loggedIn: !!req.session.user, user: req.session.user });
});

// Obtener Categorías (CORREGIDO)
app.get('/api/categorias', protect, async (req, res) => {
    try {
        // Usamos "Id" y "Nombre" entre comillas para obligar a Postgres a usar mayúsculas
        const result = await pool.query('SELECT id as "Id", nombre as "Nombre" FROM categorias ORDER BY nombre');
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// Guardar Transacción
app.post('/api/transacciones', protect, async (req, res) => {
    try {
        const { tipo, categoriaId, detalle, monto, fecha } = req.body;
        await pool.query(
            'INSERT INTO transacciones (fecha, tipo, categoria_id, detalle, monto) VALUES ($1, $2, $3, $4, $5)',
            [fecha, tipo, categoriaId, detalle, monto]
        );
        res.json({ message: 'Guardado' });
    } catch (err) { res.status(500).send(err.message); }
});

// Obtener Historial
app.get('/api/transacciones', protect, async (req, res) => {
    try {
        // COALESCE es el equivalente a ISNULL en Postgres
        const result = await pool.query(`
            SELECT t.id, t.fecha, t.tipo, t.detalle, t.monto, t.categoria_id, c.nombre as "CategoriaNombre"
            FROM transacciones t
            LEFT JOIN categorias c ON t.categoria_id = c.id
            ORDER BY t.fecha DESC
        `);
        // Mapeamos para que el Frontend reciba las mayúsculas que espera (Id, Fecha...)
        const mapped = result.rows.map(row => ({
            Id: row.id, Fecha: row.fecha, Tipo: row.tipo, 
            Detalle: row.detalle, Monto: row.monto, 
            CategoriaId: row.categoria_id, CategoriaNombre: row.CategoriaNombre
        }));
        res.json(mapped);
    } catch (err) { res.status(500).send(err.message); }
});

// Actualizar
app.put('/api/transacciones/:id', protect, async (req, res) => {
    try {
        const { id } = req.params;
        const { fecha, tipo, categoriaId, detalle, monto } = req.body;
        await pool.query(
            'UPDATE transacciones SET fecha=$1, tipo=$2, categoria_id=$3, detalle=$4, monto=$5 WHERE id=$6',
            [fecha, tipo, categoriaId, detalle, monto, id]
        );
        res.json({ message: 'Actualizado' });
    } catch (err) { res.status(500).send(err.message); }
});

// Eliminar
app.delete('/api/transacciones/:id', protect, async (req, res) => {
    try {
        await pool.query('DELETE FROM transacciones WHERE id = $1', [req.params.id]);
        res.json({ message: 'Eliminado' });
    } catch (err) { res.status(500).send(err.message); }
});

// Resumen y Gráficos
app.get('/api/resumen', protect, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN tipo = 'Ingreso' THEN monto ELSE 0 END), 0) as "TotalIngresos",
                COALESCE(SUM(CASE WHEN tipo = 'Egreso' THEN monto ELSE 0 END), 0) as "TotalEgresos"
            FROM transacciones
        `);
        const r = result.rows[0];
        // Convertimos a número porque Postgres devuelve decimales como strings a veces
        r.TotalIngresos = parseFloat(r.TotalIngresos);
        r.TotalEgresos = parseFloat(r.TotalEgresos);
        r.Balance = r.TotalIngresos - r.TotalEgresos;
        res.json(r);
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/api/gastos-categoria', protect, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.nombre as "Categoria", SUM(t.monto) as "Total"
            FROM transacciones t
            JOIN categorias c ON t.categoria_id = c.id
            WHERE t.tipo = 'Egreso'
            GROUP BY c.nombre
        `);
        res.json(result.rows.map(r => ({ Categoria: r.Categoria, Total: parseFloat(r.Total) })));
    } catch (err) { res.status(500).send(err.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor Nube listo en puerto ${PORT}`));