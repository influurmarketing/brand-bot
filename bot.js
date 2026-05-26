// ============================================================
// Brand Assets Bot — responde por DM directo en Slack
// ============================================================
// npm install @slack/bolt @anthropic-ai/sdk googleapis dotenv
// node bot.js
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { App } from "@slack/bolt";
import { google } from "googleapis";
import { config } from "dotenv";
config();

// ── Clients ─────────────────────────────────────────────────
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const driveAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});
const drive = google.drive({ version: "v3", auth: driveAuth });

// ── Carpetas y recursos de brand en Drive ───────────────────
// Carpeta raíz de brand assets
const ROOT_FOLDER_ID = "1OQq9K4WZskWOd5GJs_xJgMGbJ2VkhrVZ";

// Spreadsheet con links externos (logos, colores, tipografía, etc.)
const LINKS_SHEET_ID = "19AhVTiwrnHOqtL9UVZY2FHF9EvKhkTECb41ICtHfQDI";

// Subcarpetas dentro de la carpeta raíz (se detectan automáticamente)
// Si tienes subcarpetas fijas, puedes ponerlas aquí también
const FOLDERS = {
  root:       ROOT_FOLDER_ID,
  logos:      process.env.DRIVE_FOLDER_LOGOS       || null,
  colores:    process.env.DRIVE_FOLDER_COLORS      || null,
  tipografia: process.env.DRIVE_FOLDER_TYPOGRAPHY  || null,
  fotos:      process.env.DRIVE_FOLDER_PHOTOS      || null,
};

// ── Drive helpers ────────────────────────────────────────────
async function listFolder(folderId, limit = 10) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name, mimeType, webViewLink)",
    pageSize: limit,
    orderBy: "modifiedTime desc",
    corpora: "allDrives",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });
  return res.data.files || [];
}

async function searchFiles(query, limit = 8) {
  // Usa la búsqueda global de Drive — encuentra archivos en cualquier carpeta accesible
  const res = await drive.files.list({
    q: `fullText contains '${query}' and trashed = false`,
    fields: "files(id, name, mimeType, webViewLink)",
    pageSize: limit,
    corpora: "allDrives",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });
  return res.data.files || [];
}

/** Lee el spreadsheet extrayendo hipervínculos reales de las celdas */
async function getLinksFromSheet() {
  const sheets = google.sheets({ version: "v4", auth: driveAuth });

  // Pedimos tanto valores como metadatos de celda (para extraer URLs de hipervínculos)
  const [valuesRes, dataRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: LINKS_SHEET_ID,
      range: "A:Z",
    }),
    sheets.spreadsheets.get({
      spreadsheetId: LINKS_SHEET_ID,
      includeGridData: true,
      ranges: ["A:Z"],
    }),
  ]);

  const rows = valuesRes.data.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h?.toLowerCase().trim());

  // Extraemos URLs de hipervínculos de la metadata
  const gridRows = dataRes.data.sheets?.[0]?.data?.[0]?.rowData || [];

  return rows.slice(1).map((row, rowIdx) => {
    const obj = {};
    const gridCells = gridRows[rowIdx + 1]?.values || [];

    headers.forEach((h, i) => {
      const cellValue = row[i] || "";
      // Intentamos extraer el hipervínculo real de la celda
      const hyperlink = gridCells[i]?.hyperlink || 
                        gridCells[i]?.userEnteredValue?.formulaValue?.match(/HYPERLINK\("([^"]+)"/)?.[1] ||
                        null;
      obj[h] = hyperlink ? hyperlink : cellValue;
    });
    return obj;
  });
}

/** Busca en el spreadsheet por EVENT o EXTRA MATERIAL */
async function searchSheet(query) {
  const rows = await getLinksFromSheet();
  const q = query.toLowerCase();
  const matches = rows.filter(row =>
    Object.values(row).some(v => v.toLowerCase().includes(q))
  );
  if (!matches.length) return null;

  return matches.map(row => {
    // Busca la columna de event
    const eventKey = Object.keys(row).find(k => k.includes("event"));
    const linkKey  = Object.keys(row).find(k => k.includes("content") || k.includes("link"));
    const extraKey = Object.keys(row).find(k => k.includes("extra"));
    const yearKey  = Object.keys(row).find(k => k.includes("año") || k.includes("year"));

    const name  = eventKey  ? row[eventKey]  : "";
    const link  = linkKey   ? row[linkKey]   : "";
    const extra = extraKey  ? row[extraKey]  : "";
    const year  = yearKey   ? row[yearKey]   : "";

    let result = `• *${name}*`;
    if (year)  result += ` (${year})`;
    if (link)  result += `\n  Content: ${link}`;
    if (extra) result += `\n  Extra: ${extra}`;
    return result;
  }).join("\n\n");
}

function fmt(files) {
  if (!files.length) return "No encontré archivos.";
  return files.map(f => `• <${f.webViewLink}|${f.name}>`).join("\n");
}

// ── Tool definitions para Claude ────────────────────────────
const tools = [
  {
    name: "list_all_assets",
    description: "Lista todos los archivos en la carpeta raíz de brand assets de Drive.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_drive_files",
    description: "Busca archivos por nombre en la carpeta de brand assets de Drive.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Término de búsqueda" } },
      required: ["query"],
    },
  },
  {
    name: "search_links_sheet",
    description: "Busca en el spreadsheet de links externos de brand assets (fuentes externas, referencias, URLs de proveedores, etc.).",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Término de búsqueda" } },
      required: ["query"],
    },
  },
  {
    name: "list_links_sheet",
    description: "Devuelve todos los links y recursos del spreadsheet de brand assets.",
    input_schema: { type: "object", properties: {} },
  },
];

async function runTool(name, input) {
  if (name === "list_all_assets")    return fmt(await listFolder(ROOT_FOLDER_ID, 20));
  if (name === "search_drive_files") return fmt(await searchFiles(input.query));
  if (name === "search_links_sheet") return await searchSheet(input.query);
  if (name === "list_links_sheet") {
    const rows = await getLinksFromSheet();
    if (!rows.length) return "El spreadsheet está vacío.";
    return rows.map(row => Object.entries(row).map(([k,v]) => `${k}: ${v}`).join(" | ")).join("\n");
  }
  return "Herramienta desconocida.";
}

// ── Agente: loop de razonamiento ─────────────────────────────
async function runAgent(userText) {
  const messages = [{ role: "user", content: userText }];

  for (let i = 0; i < 5; i++) {
    const res = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: `Eres el bot de brand assets de la empresa. Los empleados te escriben por DM en Slack
para pedirte logos, guías de colores, tipografías y fotos de eventos.

Tu flujo:
1. Interpreta qué asset necesita el usuario.
2. Para fotos de eventos, usa PRIMERO search_links_sheet — ahí están organizados por nombre de evento con sus links.
3. Para logos, colores y tipografía usa search_drive_files o list_all_assets.
4. Si no encuentras en uno, busca en el otro.
5. Devuelve los links directos. Si el link viene del spreadsheet, compártelo tal cual.
6. Sé breve y amable. Responde en español.

El spreadsheet tiene columnas: EVENT (nombre), CONTENT LINK (link principal), AÑO, LENGUAJE, EXTRA MATERIAL (link adicional).
Si no encuentras nada, indica las categorías disponibles: logos, colores, tipografia, fotos de eventos. Cuando alguien pida tipografía o fuentes, comparte siempre este link de Die Grotesk: https://drive.google.com/drive/folders/1HJuP1FfGCBMe_Rwgjn-5CxHTsVfgZBQK 
Responde siempre en el mismo idioma que use el usuario. Si te escriben en inglés, responde en inglés. Si te escriben en español, responde en español. 
Cuando alguien pida brand guidelines o guía de marca, comparte siempre este link: https://drive.google.com/file/d/1g6e9lisXpwyeUk0kOvFiYvHrC2DbOLa8/view?usp=drive_link`, 
`,
      tools,
      messages,
    });

    if (res.stop_reason === "end_turn") {
      return res.content.filter(b => b.type === "text").map(b => b.text).join("\n") || "✓";
    }

    if (res.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: res.content });
      const results = [];
      for (const b of res.content) {
        if (b.type !== "tool_use") continue;
        const output = await runTool(b.name, b.input);
        results.push({ type: "tool_result", tool_use_id: b.id, content: output });
      }
      messages.push({ role: "user", content: results });
    }
  }
  return "No pude completar la búsqueda. Intenta de nuevo.";
}

// ── Historial de conversación por usuario ────────────────────
// Permite conversaciones naturales de múltiples turnos
const sessions = new Map(); // userId → [{ role, content }]

function getHistory(userId) {
  if (!sessions.has(userId)) sessions.set(userId, []);
  return sessions.get(userId);
}

function clearHistory(userId) {
  sessions.delete(userId);
}

// ── Escucha mensajes directos ────────────────────────────────
slack.event("message", async ({ event, client }) => {
  // Solo DMs (channel_type: "im"), ignorar mensajes del propio bot
  if (event.channel_type !== "im" || event.bot_id) return;

  const userId = event.user;
  const text = event.text?.trim();
  if (!text) return;

  // Comando para limpiar historial
  if (["limpiar", "reset", "nuevo", "start"].includes(text.toLowerCase())) {
    clearHistory(userId);
    await client.chat.postMessage({
      channel: event.channel,
      text: "🗑️ Historial borrado. ¿Qué asset necesitas?",
    });
    return;
  }

  // Indicador de escritura
  await client.chat.postMessage({
    channel: event.channel,
    text: "🔍 Buscando en Drive...",
  });

  try {
    const reply = await runAgent(text);
    await client.chat.postMessage({
      channel: event.channel,
      text: reply,
      // Desplega links como unfurl automáticamente
      unfurl_links: true,
      unfurl_media: true,
    });
  } catch (err) {
    console.error(err);
    await client.chat.postMessage({
      channel: event.channel,
      text: "❌ Algo salió mal. Intenta de nuevo.",
    });
  }
});

// ── App Home: pantalla de bienvenida cuando abren el bot ─────
slack.event("app_home_opened", async ({ event, client }) => {
  await client.views.publish({
    user_id: event.user,
    view: {
      type: "home",
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "🎨 Brand Assets Bot" },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Escríbeme un *mensaje directo* para encontrar cualquier asset de marca.\n\nBusco en Google Drive y te mando el link al instante.",
          },
        },
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Ejemplos de lo que puedes pedirme:*\n• `logos en PNG`\n• `guía de colores`\n• `tipografía para presentaciones`\n• `fotos del evento de marzo`\n• `logo fondo transparente`",
          },
        },
        { type: "divider" },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "Escribe *limpiar* para reiniciar la conversación.",
            },
          ],
        },
      ],
    },
  });
});

// ── Arranque ─────────────────────────────────────────────────
(async () => {
  await slack.start();
  console.log("✅ Brand Assets Bot activo — escuchando DMs");
})();
