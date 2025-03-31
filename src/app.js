
// app.js
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const axios = require('axios'); // P
const app = express();
app.use(express.json());

// Directorio para guardar las sesiones
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR);
}

// Objeto para almacenar clientes activos
const clients = {};

// Modelos de respuesta por defecto
const defaultResponses = {
    'hola': '¡Hola! ¿En qué puedo ayudarte?',
    'adios': '¡Hasta luego!',
    'gracias': 'De nada, estoy aquí para ayudarte'
};

// Función para inicializar un cliente WhatsApp
    //   // Manejar mensajes
    // client.on('message', async (msg) => {
    //   if (msg.from.endsWith('@c.us')) {
    //     const message = msg.body.toLowerCase();
    //     // const response = defaultResponses[message] || 'No entiendo, ¿cómo puedo ayudarte?';
    //     const response = defaultResponses[message]
    //     await msg.reply(response);
    //   }

// Función para inicializar un cliente WhatsApp
// Función para inicializar un cliente WhatsApp
// Función para inicializar un cliente WhatsApp
const initializeClient = async (sessionId) => {
    console.log(`[INFO] Inicializando cliente para sesión ${sessionId}`);

    const client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: sessionId,
            dataPath: SESSIONS_DIR 
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox']
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        },
    });

    client.on('qr', (qr) => {
        console.log(`[INFO] Generando QR para sesión ${sessionId}. Escanea este QR:`);
        console.log('Esto es QR', qr)
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

    // client.on('message', async (msg) => {
    //     console.log(msg.body.toLowerCase(), msg.from.endsWith('@c.us'), msg.from)
    //     if (msg.from.endsWith('@c.us')) {
    //         const message = msg.body.toLowerCase();
    //         const response = defaultResponses[message] || 'No entiendo, ¿cómo puedo ayudarte?';
    //         await msg.reply(response);
    //     }
    // });

    // Modificación en el manejador de mensajes
    client.on('message', async (msg) => {
        if (msg.from.endsWith('@c.us') && !msg.fromMe) { // Solo mensajes personales y no enviados por mí
            const message = msg.body.toLowerCase();
            try {
                const contact = await client.getContactById(msg.from);
                const isContact = contact.isMyContact; // true si está en tus contactos

                if (isContact) {
                    console.log(`[INFO] Mensaje de contacto registrado: ${msg.from} - ${message}`);
                    // const response = defaultResponses[message] || 'Hola, estás en mis contactos. ¿Cómo puedo ayudarte?';
                    // await msg.reply(response);
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
        // Guardamos el cliente inmediatamente después de initialize, pero verificamos su estado
        clients[sessionId] = client;
        console.log(`[DEBUG] Sesión ${sessionId} guardada en clients tras initialize. Sesiones activas: ${Object.keys(clients).join(', ') || 'Ninguna'}`);

        // Verificamos si el cliente está realmente conectado
        const state = await client.getState();
        if (state === 'CONNECTED') {
            console.log(`[INFO] Clienteno msm ${sessionId} confirmado como conectado`);
        } else {
            console.log(`[WARN] Cliente ${sessionId} inicializado pero no conectado (estado: ${state}). Esperando 'ready'...`);
        }
        return client;
    } catch (error) {
        console.error(`[ERROR] Error inicializando cliente ${sessionId}:`, error);
        delete clients[sessionId]; // Eliminamos si falla la inicialización
        throw error;
    }
};

// Función para cargar sesiones existentes
const loadExistingSessions = async () => {
    try {
        const sessionFiles = fs.readdirSync(SESSIONS_DIR).filter(file => file.startsWith('session-'));
        const sessionIds = sessionFiles.map(file => file.replace('session-', ''));

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
// Endpoint para crear nueva sesión
app.post('/api/session', async (req, res) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) {
            return res.status(400).json({ error: 'Se requiere sessionId' });
        }
        
        if (clients[sessionId]) {
            return res.status(400).json({ error: 'La sesión ya existe' });
        }

        await initializeClient(sessionId);
        res.json({ message: `Sesión ${sessionId} creada. Escanea el QR en la terminal` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Endpoint actualizado para enviar mensajes, imágenes o archivos
app.post('/api/send2', async (req, res) => {
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

      // Si hay contenido multimedia
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
      } 
      // Si es solo texto
      else if (message) {
          await client.sendMessage(chatId, message);
      } else {
          return res.status(400).json({ error: 'Se requiere message o media' });
      }

      res.json({ message: 'Contenido enviado con éxito' });
  } catch (error) {
      res.status(500).json({ error: `Error al enviar: ${error.message}` });
  }
});

// Endpoint para enviar mensaje
app.post('/api/send', async (req, res) => {
    try {
        const { sessionId, number, message } = req.body;
        
        if (!sessionId || !number || !message) {
            return res.status(400).json({ error: 'Faltan parámetros' });
        }

        const client = clients[sessionId];
        console.log(clients)
        if (!client) {
            return res.status(404).json({ error: 'Sesión no encontrada' });
        }

        const chatId = `${number}@c.us`;
        await client.sendMessage(chatId, message);
        res.json({ message: 'Mensaje enviado con éxito' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Endpoint para obtener estado de sesión
app.get('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  console.log(sessionId, clients)
  const client = clients[sessionId];
  
  if (!client) {
      return res.status(404).json({ error: 'Sesión no encontrada' });
  }
  
  client.getState()
      .then((state) => {
          res.json({ 
              status: state || 'DISCONNECTED',
              sessionId 
          });
      })
      .catch(() => {
          res.json({ 
              status: 'DISCONNECTED',
              sessionId 
          });
      });
});

// Endpoint para agregar modelo de respuesta
app.get('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const client = clients[sessionId];
  
  console.log(`[INFO] Verificando estado de sesión ${sessionId}`);
  if (!client) {
      console.log(`[WARN] Sesión ${sessionId} no encontrada en clients`);
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
app.get('/', (req, res) => {
    const html = `
        <html>
        <head>
        <tittle>VERCEL</tittle>
        </head>
        <body>
            <h1>HOLA QUE SHOW REDROGOd</h1>
        </body>
        </html>
    `   
    res.send(html)
});

// Cargar sesiones al iniciar el servidor
(async () => {
  console.log('[INFO] Iniciando carga de sesiones existentes...');
  await loadExistingSessions();
  console.log('[INFO] Carga de sesiones completada');
})();

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});