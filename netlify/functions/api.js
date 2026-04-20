// ═══════════════════════════════════════════════════════════════
// 🚀 API.JS — Backend completo (Telegram + OpenAI proxy)
// ═══════════════════════════════════════════════════════════════
// Variables de entorno requeridas en Netlify:
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
//   TELEGRAM_BOT_TOKEN, OPENAI_API_KEY

const admin = require('firebase-admin');

const EJERCICIOS_VALIDOS = [
    'sentadilla', 'peso_muerto', 'press_banca',
    'press_militar', 'hip_thrust', 'jalon_remo'
];

// ── Firebase init (lazy) ──────────────────────────────────────
function getDB() {
    if (!admin.apps.length) {
        const privateKey = process.env.FIREBASE_PRIVATE_KEY
            ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            : undefined;

        console.log('Iniciando Firebase:', {
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKeyStart: privateKey ? privateKey.substring(0, 40) : 'MISSING'
        });

        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey
            })
        });
    }
    return admin.firestore();
}

// ── Helpers ───────────────────────────────────────────────────

function calcularRM(peso, reps) {
    return reps === 1 ? peso : Math.round(peso * (36 / (37 - reps)));
}

function parsearMensaje(texto) {
    const match = texto.match(/([a-záéíóú_\s]+?)\s+(\d+\.?\d*)\s*(?:kg)?\s*[xX]\s*(\d+)/i);
    if (!match) return null;
    return {
        ejercicio: match[1].trim().toLowerCase().replace(/\s+/g, '_'),
        peso: parseFloat(match[2]),
        repeticiones: parseInt(match[3])
    };
}

async function enviarMensaje(chatId, texto) {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'Markdown' })
    });
}

async function registrarEjercicio(db, userId, ejercicio, peso, repeticiones) {
    const fecha = new Date().toISOString().split('T')[0];
    const rm = calcularRM(peso, repeticiones);
    const ref = db.collection('usuarios').doc(userId).collection('ejercicios').doc(ejercicio);
    const doc = await ref.get();
    const prev = doc.exists ? doc.data() : {};

    await ref.set({
        ultimo_registro: { peso, repeticiones },
        registro_anterior: prev.ultimo_registro || { peso: 0, repeticiones: 0 },
        rm_estimado_actual: rm,
        rm_estimado_anterior: prev.rm_estimado_actual || 0,
        progreso: rm - (prev.rm_estimado_actual || 0),
        fecha_actualizacion: fecha
    }, { merge: true });

    await ref.collection('historial').add({ fecha, peso, repeticiones, rm_estimado: rm });
    return { rm, progreso: rm - (prev.rm_estimado_actual || 0) };
}

async function llamarOpenAI(prompt, maxTokens = 1000) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt }]
        })
    });
    const data = await res.json();
    return data.choices[0].message.content;
}

// ── Handler principal ─────────────────────────────────────────

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // ── Proxy OpenAI ─────────────────────────────────────────
    if (event.path.includes('ai-analysis')) {
        try {
            const { prompt, maxTokens } = JSON.parse(event.body);
            const text = await llamarOpenAI(prompt, maxTokens || 1000);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            };
        } catch (e) {
            console.error('OpenAI error:', e);
            return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
        }
    }

    // ── Telegram Webhook ─────────────────────────────────────
    try {
        const db = getDB();
        const update = JSON.parse(event.body);
        if (!update.message?.text) return { statusCode: 200, body: 'OK' };

        const chatId = update.message.chat.id;
        const texto = update.message.text.trim();
        const userId = String(chatId);

        if (texto === '/start') {
            await enviarMensaje(chatId,
                `¡Hola! 👋 Soy tu *Fitness AI Coach*.\n\n` +
                `📝 Registra un ejercicio:\n\`sentadilla 120kg x5\`\n\`press banca 85 x 8\`\n\n` +
                `📊 Ejercicios disponibles:\n` +
                EJERCICIOS_VALIDOS.map(e => `• ${e.replace('_', ' ')}`).join('\n')
            );
            return { statusCode: 200, body: 'OK' };
        }

        if (texto === '/historial') {
            let msg = '*📅 Último registro por ejercicio:*\n\n';
            for (const ej of EJERCICIOS_VALIDOS) {
                const snap = await db.collection('usuarios').doc(userId)
                    .collection('ejercicios').doc(ej)
                    .collection('historial')
                    .orderBy('fecha', 'desc').limit(1).get();
                if (!snap.empty) {
                    const d = snap.docs[0].data();
                    msg += `*${ej.replace('_', ' ')}*: ${d.peso}kg x${d.repeticiones} — RM ${d.rm_estimado}kg (${d.fecha})\n`;
                }
            }
            await enviarMensaje(chatId, msg);
            return { statusCode: 200, body: 'OK' };
        }

        const datos = parsearMensaje(texto);
        if (!datos) {
            await enviarMensaje(chatId,
                `❌ No entendí el formato.\n\nUsa: \`ejercicio peso x reps\`\nEjemplo: \`sentadilla 120kg x5\``
            );
            return { statusCode: 200, body: 'OK' };
        }

        if (!EJERCICIOS_VALIDOS.includes(datos.ejercicio)) {
            await enviarMensaje(chatId,
                `❌ Ejercicio no reconocido: *${datos.ejercicio}*\n\n` +
                `Válidos:\n` + EJERCICIOS_VALIDOS.map(e => `• ${e.replace('_', ' ')}`).join('\n')
            );
            return { statusCode: 200, body: 'OK' };
        }

        const resultado = await registrarEjercicio(db, userId, datos.ejercicio, datos.peso, datos.repeticiones);
        const emoji = resultado.progreso > 0 ? '📈' : resultado.progreso < 0 ? '📉' : '➡️';

        await enviarMensaje(chatId,
            `✅ *${datos.ejercicio.replace('_', ' ').toUpperCase()}* registrado\n\n` +
            `💪 ${datos.peso}kg × ${datos.repeticiones} reps\n` +
            `🎯 RM estimado: *${resultado.rm}kg*\n` +
            `${emoji} Progreso: ${resultado.progreso > 0 ? '+' : ''}${resultado.progreso}kg`
        );

        return { statusCode: 200, body: 'OK' };

    } catch (e) {
        console.error('Error completo:', e.message, e.stack);
        return { statusCode: 500, body: 'Internal Server Error' };
    }
};