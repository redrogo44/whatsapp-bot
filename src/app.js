require('dotenv').config();
// app.js
const express = require('express');
const { Client, MessageMedia, AuthStrategy } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json());

// Configuración de la conexión a MySQL
const dbConfig = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
};

const clients = {};
const defaultResponses = {
    'hola': '¡Hola! ¿En qué puedo ayudarte?',
    'adios': '¡Hasta luego!',
    'gracias': 'De nada, estoy aquí para ayudarte'
};

// Estrategia de autenticación personalizada para MySQL
class MySQLAuth extends AuthStrategy {
    constructor(sessionId) {
        super();
        this.sessionId = sessionId;
        this.sessionData = null;
    }

    async beforeBrowserInitialized() {
        console.log(`[INFO] Antes de inicializar el navegador para ${this.sessionId}`);
        const sessionData = await this.loadSessionFromMySQL();
        if (sessionData) {
            this.sessionData = sessionData;
            console.log(`[INFO] Sesión cargada desde MySQL para ${this.sessionId}`);
            this.client.options.authState = sessionData; // Pasamos los datos de autenticación al cliente
        }
    }

    async afterAuthReady() {
        console.log(`[INFO] Después de autenticación lista para ${this.sessionId} (afterAuthReady)`);
        const sessionData = this.client.authState; // Obtenemos los datos de autenticación del cliente
        await this.saveSessionData(sessionData);
    }

    async saveSessionData(sessionData) {
        console.log(`[DEBUG] Intentando guardar datos de sesión para ${this.sessionId}`);
        if (!sessionData) {
            console.warn(`[WARN] No se recibieron datos de sesión para guardar en ${this.sessionId}`);
            return;
        }
        const connection = await mysql.createConnection(dbConfig);
        try {
            const serializedData = JSON.stringify(sessionData);
            console.log(`[DEBUG] Datos serializados para ${this.sessionId}: ${serializedData.substring(0, 100)}...`);
            await connection.execute(
                'INSERT INTO whatsapp_sessions (session_id, session_data) VALUES (?, ?) ON DUPLICATE KEY UPDATE session_data = ?, updated_at = NOW()',
                [this.sessionId, serializedData, serializedData]
            );
            console.log(`[DEBUG] Datos de autenticación guardados en MySQL para ${this.sessionId}`);
            this.sessionData = sessionData;
        } catch (error) {
            console.error(`[ERROR] Error al guardar datos de autenticación en MySQL: ${error.message}`);
        } finally {
            await connection.end();
        }
    }

    async loadSessionFromMySQL() {
        console.log(`[INFO] Intentando cargar sesión para ${this.sessionId} desde MySQL`);
        const connection = await mysql.createConnection(dbConfig);
        try {
            const [rows] = await connection.execute(
                'SELECT session_data FROM whatsapp_sessions WHERE session_id = ?',
                [this.sessionId]
            );
            if (rows.length > 0) {
                const sessionData = JSON.parse(rows[0].session_data);
                console.log(`[DEBUG] Datos de sesión cargados desde MySQL para ${this.sessionId}: ${JSON.stringify(sessionData).substring(0, 100)}...`);
                return sessionData;
            }
            console.log(`[INFO] No se encontraron datos de sesión para ${this.sessionId} en MySQL`);
            return null;
        } catch (error) {
            console.error(`[ERROR] Error al cargar datos de sesión desde MySQL: ${error.message}`);
            return null;
        } finally {
            await connection.end();
        }
    }

    async logout() {
        console.log(`[INFO] Cerrando sesión para ${this.sessionId}`);
        const connection = await mysql.createConnection(dbConfig);
        try {
            await connection.execute('DELETE FROM whatsapp_sessions WHERE session_id = ?', [this.sessionId]);
            console.log(`[INFO] Sesión ${this.sessionId} eliminada de MySQL`);
        } catch (error) {
            console.error(`[ERROR] Error al eliminar sesión de MySQL: ${error.message}`);
        } finally {
            await connection.end();
        }
        this.sessionData = null;
    }
}

// Función para inicializar un cliente WhatsApp
const initializeClient = async (sessionId) => {
    console.log(`[INFO] Inicializando cliente para sesión ${sessionId}`);

    const authStrategy = new MySQLAuth(sessionId);
    const client = new Client({
        authStrategy,
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        },
    });

    client.on('qr', (qr) => {
        console.log(`[INFO] Evento 'qr' disparado para ${sessionId}`);
        console.log(`[INFO] Generando QR para sesión ${sessionId}. Escanea este QR:`);
        qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', async () => {
        console.log(`[INFO] Evento 'authenticated' disparado para ${sessionId}`);
        const sessionData = client.authState;
        console.log(`[DEBUG] Datos de sesión recibidos en 'authenticated': ${JSON.stringify(sessionData)}`);
        clients[sessionId] = client;
        console.log(`[DEBUG] Sesión ${sessionId} guardada en clients tras authenticated. Sesiones activas: ${Object.keys(clients).join(', ') || 'Ninguna'}`);
        await authStrategy.saveSessionData(sessionData);
    });

    client.on('ready', async () => {
        console.log(`[INFO] Evento 'ready' disparado para ${sessionId}`);
        clients[sessionId] = client;
        console.log(`[DEBUG] Sesión ${sessionId} guardada en clients tras ready. Sesiones activas: ${Object.keys(clients).join(', ') || 'Ninguna'}`);
        const sessionData = client.authState;
        console.log(`[DEBUG] Datos de sesión obtenidos en 'ready': ${JSON.stringify(sessionData)}`);
        await authStrategy.saveSessionData(sessionData);
    });

    client.on('auth_failure', (msg) => {
        console.error(`[ERROR] Fallo de autenticación para ${sessionId}: ${msg}`);
        delete clients[sessionId];
    });

    client.on('disconnected', (reason) => {
        console.log(`[INFO] Cliente ${sessionId} desconectado: ${reason}`);
        delete clients[sessionId];
        console.log(`[DEBUG] Sesión ${sessionId} eliminada de clients. Sesiones activas: ${Object.keys(clients).join(', ') || 'Ninguna'}`);
    });

    client.on('change_state', (state) => {
        console.log(`[INFO] Cambio de estado para ${sessionId}: ${state}`);
    });

    try {
        console.log(`[INFO] Iniciando inicialización del cliente para ${sessionId}`);
        await client.initialize();
        console.log(`[INFO] Inicialización completada para ${sessionId}`);
        clients[sessionId] = client;
        console.log(`[DEBUG] Sesión ${sessionId} guardada en clients tras initialize. Sesiones activas: ${Object.keys(clients).join(', ') || 'Ninguna'}`);
        const state = await client.getState();
        if (state === 'CONNECTED') {
            console.log(`[INFO] Cliente ${sessionId} confirmado como conectado`);
        } else {
            console.log(`[WARN] Cliente ${sessionId} inicializado pero no conectado (estado: ${state}). Esperando 'ready'...`);
        }
        return client;
    } catch (error) {
        console.error(`[ERROR] Error inicializando cliente ${sessionId}: ${error.message}`);
        console.error(`[ERROR] Detalles del error: ${error.stack}`);
        delete clients[sessionId];
        throw error;
    }
};

// Función para cargar sesiones existentes desde MySQL
const loadExistingSessions = async () => {
    const connection = await mysql.createConnection(dbConfig);
    try {
        const [rows] = await connection.execute('SELECT session_id FROM whatsapp_sessions');
        const sessionIds = rows.map(row => row.session_id);

        console.log(`[INFO] Sesiones encontradas en MySQL: ${sessionIds.length > 0 ? sessionIds.join(', ') : 'Ninguna'}`);

        for (const sessionId of sessionIds) {
            if (!clients[sessionId]) {
                console.log(`[INFO] Cargando sesión existente: ${sessionId}`);
                await initializeClient(sessionId);
            } else {
                console.log(`[INFO] Sesión ${sessionId} ya está activa en clients, omitiendo carga`);
            }
        }
    } catch (error) {
        console.error('[ERROR] Error al cargar sesiones existentes desde MySQL:', error);
    } finally {
        await connection.end();
    }
};

const getMedia = async (type, content) => {
    if (type === 'url') {
        const response = await axios.get(content, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');
        const mimeType = response.headers['content-type'];
        return new MessageMedia(mimeType, buffer.toString('base64'));
    } else if (type === 'base64') {
        const [mimePart, data] = content.split(',');
        const mimeType = mimePart.match(/:(.*?);/)[1];
        return new MessageMedia(mimeType, data);
    }
    throw new Error('Tipo de contenido no soportado');
};

console.log('[INFO] Iniciando servidor y cargando sesiones existentes desde MySQL...');
loadExistingSessions().then(() => {
    console.log('[INFO] Carga inicial de sesiones completada');
}).catch((error) => {
    console.error('[ERROR] Error durante la carga inicial:', error);
});

app.post('/api/session', async (req, res) => {
    console.log(`[API] Petición recibida: POST /api/session - Datos: ${JSON.stringify(req.body)}`);
    try {
        const { sessionId } = req.body;
        if (!sessionId) {
            return res.status(400).json({ error: 'Se requiere sessionId' });
        }
        
        if (clients[sessionId]) {
            return res.status(400).json({ error: 'La sesión ya existe y está activa' });
        }

        console.log(`[INFO] Creando nueva sesión: ${sessionId}`);
        await initializeClient(sessionId);
        res.json({ message: `Sesión ${sessionId} creada. Escanea el QR si es necesario` });
    } catch (error) {
        console.error(`[ERROR] Error en POST /api/session: ${error.message}`);
        res.status(500).json({ error: `Error al crear sesión: ${error.message}` });
    }
});

app.post('/api/send', async (req, res) => {
    console.log(`[API] Petición recibida: POST /api/send - Datos: ${JSON.stringify(req.body)}`);
    try {
        const { sessionId, number, message, media } = req.body;

        if (!sessionId || !number) {
            return res.status(400).json({ error: 'Faltan parámetros: sessionId y number son requeridos' });
        }

        const client = clients[sessionId];
        if (!client) {
            return res.status(404).json({ error: 'Sesión no encontrada o no está lista' });
        }

        const info = await client.getState();
        if (info !== 'CONNECTED') {
            return res.status(400).json({ error: 'El cliente no está conectado' });
        }

        const chatId = `${number}@c.us`;

        if (media) {
            const { type, content, filename } = media;
            if (!type || !content) {
                return res.status(400).json({ error: 'Media requiere type y content' });
            }

            const mediaObject = await getMedia(type, content);
            await client.sendMessage(chatId, mediaObject, { 
                caption: message || '', 
                mediaFilename: filename 
            });
        } else if (message) {
            await client.sendMessage(chatId, message);
        } else {
            return res.status(400).json({ error: 'Se requiere message o media' });
        }

        res.json({ message: 'Contenido enviado con éxito' });
    } catch (error) {
        console.error(`[ERROR] Error en POST /api/send: ${error.message}`);
        res.status(500).json({ error: `Error al enviar: ${error.message}` });
    }
});

app.get('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    console.log(`[API] Petición recibida: GET /api/session/${sessionId}`);
    
    const client = clients[sessionId];
    if (!client) {
        console.log(`[WARN] Sesión ${sessionId} no encontrada en clients. Sesiones activas: ${Object.keys(clients).join(', ') || 'Ninguna'}`);
        return res.status(404).json({ error: 'Sesión no encontrada' });
    }
    
    client.getState()
        .then((state) => {
            console.log(`[INFO] Estado de ${sessionId}: ${state}`);
            res.json({ 
                status: state || 'DISCONNECTED',
                sessionId 
            });
        })
        .catch((error) => {
            console.error(`[ERROR] Error en GET /api/session/${sessionId}: ${error.message}`);
            res.json({ 
                status: 'DISCONNECTED',
                sessionId 
            });
        });
});

app.post('/api/response-model', (req, res) => {
    console.log(`[API] Petición recibida: POST /api/response-model - Datos: ${JSON.stringify(req.body)}`);
    try {
        const { sessionId, trigger, response } = req.body;
        
        if (!sessionId || !trigger || !response) {
            return res.status(400).json({ error: 'Faltan parámetros' });
        }

        if (!clients[sessionId]) {
            return res.status(404).json({ error: 'Sesión no encontrada' });
        }

        defaultResponses[trigger.toLowerCase()] = response;
        res.json({ message: 'Modelo de respuesta agregado' });
    } catch (error) {
        console.error(`[ERROR] Error en POST /api/response-model: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[INFO] Servidor corriendo en puerto ${PORT}`);
});