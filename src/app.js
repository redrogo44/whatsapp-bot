// app.js
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json());

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR);
}

const clients = {};
const defaultResponses = {
    'hola': '¡Hola! ¿En qué puedo ayudarte?',
    'adios': '¡Hasta luego!',
    'gracias': 'De nada, estoy aquí para ayudarte'
};

// Función para inicializar un cliente WhatsApp con configuración de Puppeteer
const initializeClient = async (sessionId) => {
    console.log(`[INFO] Inicializando cliente para sesión ${sessionId}`);

    const client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: sessionId,
            dataPath: SESSIONS_DIR 
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',           // Necesario para entornos sin permisos de sandbox
                '--disable-setuid-sandbox', // Desactiva sandbox adicional
                '--disable-dev-shm-usage', // Evita problemas con memoria compartida en contenedores
                '--disable-gpu',          // GPU no es necesario en headless
                '--single-process'        // Reduce uso de recursos
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
    });

    client.on('ready', () => {
        console.log(`[INFO] Cliente ${sessionId} está listo`);
        clients[sessionId] = client;
        console.log(`[DEBUG] Sesión ${sessionId} guardada en clients tras ready. Sesiones activas: ${Object.keys(clients).join(', ') || 'Ninguna'}`);
    });

    client.on('auth_failure', (msg) => {
        console.error(`[ERROR] Fallo de autenticación para ${sessionId}: ${msg}`);
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

const loadExistingSessions = async () => {
    try {
        const sessionFiles = fs.readdirSync(SESSIONS_DIR).filter(file => file.startsWith('.wwebjs_auth_session_'));
        const sessionIds = sessionFiles.map(file => file.replace('.wwebjs_auth_session_', ''));

        console.log(`[INFO] Sesiones encontradas en disco: ${sessionIds.length > 0 ? sessionIds.join(', ') : 'Ninguna'}`);

        for (const sessionId of sessionIds) {
            if (!clients[sessionId]) {
                console.log(`[INFO] Cargando sesión existente: ${sessionId}`);
                await initializeClient(sessionId);
            } else {
                console.log(`[INFO] Sesión ${sessionId} ya está activa en clients, omitiendo carga`);
            }
        }
    } catch (error) {
        console.error('[ERROR] Error al cargar sesiones existentes:', error);
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

console.log('[INFO] Iniciando servidor y cargando sesiones existentes...');
loadExistingSessions().then(() => {
    console.log('[INFO] Carga inicial de sesiones completada');
}).catch((error) => {
    console.error('[ERROR] Error durante la carga inicial:', error);
});

app.post('/api/session', async (req, res) => {
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
        res.status(500).json({ error: `Error al crear sesión: ${error.message}` });
    }
});

app.post('/api/send', async (req, res) => {
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
        res.status(500).json({ error: `Error al enviar: ${error.message}` });
    }
});

app.get('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    console.log(`[INFO] Solicitando estado de sesión ${sessionId}`);
    
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
            console.error(`[ERROR] Error obteniendo estado de ${sessionId}:`, error);
            res.json({ 
                status: 'DISCONNECTED',
                sessionId 
            });
        });
});

app.post('/api/response-model', (req, res) => {
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
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[INFO] Servidor corriendo en puerto ${PORT}`);
});