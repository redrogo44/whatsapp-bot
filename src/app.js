// app.js
const express = require('express');
const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();
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
class MySQLAuth {
    constructor(sessionId) {
        this.sessionId = sessionId;
    }

    async setup(client) {
        this.client = client;
        console.log(`[INFO] Configurando autenticación para ${this.sessionId}`);
    }

    async authenticate() {
        const connection = await mysql.createConnection(dbConfig);
        try {
            const [rows] = await connection.execute(
                'SELECT session_data FROM whatsapp_sessions WHERE session_id = ?',
                [this.sessionId]
            );
            if (rows.length > 0) {
                const data = JSON.parse(rows[0].session_data);
                console.log(`[DEBUG] Datos de autenticación cargados desde MySQL para ${this.sessionId}`);
                return data;
            }
            console.log(`[INFO] No se encontraron datos de autenticación para ${this.sessionId}, generando nuevo QR`);
            return null; // Si no hay datos, se generará un QR
        } catch (error) {
            console.error(`[ERROR] Error al cargar datos de autenticación desde MySQL: ${error.message}`);
            return null;
        } finally {
            await connection.end();
        }
    }

    async save(data) {
        const connection = await mysql.createConnection(dbConfig);
        try {
            const serializedData = JSON.stringify(data);
            await connection.execute(
                'INSERT INTO sessions (session_id, session_data) VALUES (?, ?) ON DUPLICATE KEY UPDATE session_data = ?, updated_at = NOW()',
                [this.sessionId, serializedData, serializedData]
            );
            console.log(`[DEBUG] Datos de autenticación guardados en MySQL para ${this.sessionId}`);
        } catch (error) {
            console.error(`[ERROR] Error al guardar datos de autenticación en MySQL: ${error.message}`);
        } finally {
            await connection.end();
        }
    }

    async logout() {
        const connection = await mysql.createConnection(dbConfig);
        try {
            await connection.execute('DELETE FROM whatsapp_sessions WHERE session_id = ?', [this.sessionId]);
            console.log(`[INFO] Sesión ${this.sessionId} eliminada de MySQL`);
        } catch (error) {
            console.error(`[ERROR] Error al eliminar sesión de MySQL: ${error.message}`);
        } finally {
            await connection.end();
        }
    }
}

// Función para inicializar un cliente WhatsApp
const initializeClient = async (sessionId) => {
    console.log(`[INFO] Inicializando cliente para sesión ${sessionId}`);

    const client = new Client({
        authStrategy: new MySQLAuth(sessionId),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process'
            ]
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        },
    });

    client.on('qr', (qr) => {
        console.log(`[INFO] Generando QR para sesión ${sessionId}. Escanea este QR:`);
        qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', () => {
        console.log(`[INFO] Sesión ${sessionId} autenticada correctamente`);
        clients[sessionId] = client;
        console.log(`[DEBUG] Sesión ${sessionId} guardada en clients tras authenticated. Sesiones activas: ${Object.keys(clients).join(', ') || 'Ninguna'}`);
    });

    client.on('ready', () => {
        console.log(`[INFO] Cliente ${sessionId} está listo`);
        clients[sessionId] = client;
        console.log(`[DEBUG] Sesión ${sessionId} guardada en clients tras ready. Sesiones activas: ${Object.keys(clients).join(', ') || 'Ninguna'}`);
    });

    client.on('auth_failure', (msg) => {
        console.error(`[ERROR] Fallo de autenticación para ${sessionId}: ${msg}`);
        delete clients[sessionId];
    });

    client.on('message', async (msg) => {
        if (msg.from.endsWith('@c.us') && !msg.fromMe) {
            const message = msg.body.toLowerCase();
            try {
                const contact = await client.getContactById(msg.from);
                const isContact = contact.isMyContact;

                if (isContact) {
                    console.log(`[INFO] Mensaje de contacto registrado: ${msg.from} - ${message}`);
                    const response = defaultResponses[message] || 'Hola, estás en mis contactos. ¿Cómo puedo ayudarte?';
                    await msg.reply(response);
                } else {
                    console.log(`[INFO] Mensaje de número no registrado: ${msg.from} - ${message}`);
                    const response = defaultResponses[message] || 'Hola, no estás en mis contactos. ¿En qué te puedo ayudar?';
                    await msg.reply(response);
                }
            } catch (error) {
                console.error(`[ERROR] Error al obtener contacto ${msg.from}:`, error);
                await msg.reply('Ocurrió un error al procesar tu mensaje.');
            }
        }
    });

    client.on('disconnected', (reason) => {
        console.log(`[INFO] Cliente ${sessionId} desconectado: ${reason}`);
        delete clients[sessionId];
        console.log(`[DEBUG] Sesión ${sessionId} eliminada de clients. Sesiones activas: ${Object.keys(clients).join(', ') || 'Ninguna'}`);
    });

    try {
        await client.initialize();
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
        console.error(`[ERROR] Error inicializando cliente ${sessionId}:`, error);
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