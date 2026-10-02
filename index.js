require('dotenv').config();
const {
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
  AttachmentBuilder,
} = require('discord.js');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const TOKEN = process.env.DISCORD_TOKEN;
const TOOL_PATH =
  process.env.TOOL_PATH || path.join(__dirname, 'tool', 'bin', 'pdeobf.js');
const TOOL_ROOT = path.resolve(path.dirname(TOOL_PATH), '..');

const MAX_INPUT = 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
const TIMEOUT_MS = 60 * 1000;
const MAX_CONCURRENT = 2;
const ALLOWED_EXT = ['.lua', '.luau', '.txt'];

const MESSAGES = {
  badExt: '❌ ارفع ملف بصيغة `.lua` أو `.luau` أو `.txt` بس.',
  tooBig: '❌ الملف كبير، الحد الأقصى 1MB.',
  download: '❌ ما قدرت أحمّل الملف، جرب مرة ثانية.',
  unsupported:
    '❌ هذا التشفير غير مدعوم، أو الأداة ما قدرت تعالج الملف.\nالمدعوم: Prometheus (آخر نسخة + نسخة WeAreDevs).',
  timeout: '❌ المعالجة أخذت وقت طويل وانلغت، الملف غالباً غير مدعوم.',
  outputTooBig: '❌ الناتج كبير مرة وما أقدر أرسله.',
  internal: '❌ صار خطأ غير متوقع، جرب مرة ثانية.',
  done: '✅ تم فك التشفير',
};

const commands = [
  new SlashCommandBuilder()
    .setName('wdecode')
    .setDescription('فك تشفير سكربت لوا (Prometheus / WeAreDevs)')
    .addAttachmentOption((option) =>
      option
        .setName('file')
        .setDescription('ملف السكربت (.lua / .txt)')
        .setRequired(true)
    )
    .toJSON(),
];

const normalize = (text) => text.replace(/\s+/g, '');

let active = 0;
const waiting = [];

function acquire() {
  return new Promise((resolve) => {
    if (active < MAX_CONCURRENT) {
      active += 1;
      resolve();
    } else {
      waiting.push(resolve);
    }
  });
}

function release() {
  const next = waiting.shift();
  if (next) {
    next();
  } else {
    active -= 1;
  }
}

async function runDeobfuscator(source) {
  let dir;
  try {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wdecode-'));
    const inFile = path.join(dir, 'input.lua');
    const outFile = path.join(dir, 'output.lua');
    await fsp.writeFile(inFile, source, 'utf8');

    const error = await new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--max-old-space-size=384', TOOL_PATH, inFile, '-o', outFile],
        {
          cwd: TOOL_ROOT,
          timeout: TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
          env: { PATH: process.env.PATH, HOME: dir },
          windowsHide: true,
        },
        (err) => resolve(err)
      );
    });

    if (error) {
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { status: 'failed' };
      }
      if (error.killed) {
        return { status: 'timeout' };
      }
      return { status: 'failed' };
    }

    const output = await fsp.readFile(outFile, 'utf8').catch(() => '');
    if (!output.trim()) {
      return { status: 'failed' };
    }
    if (normalize(output) === normalize(source)) {
      return { status: 'failed' };
    }
    return { status: 'ok', output };
  } catch (err) {
    console.error(err);
    return { status: 'failed' };
  } finally {
    if (dir) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function send(interaction, payload) {
  return interaction.editReply(payload).catch((err) => console.error(err));
}

async function handleDecode(interaction) {
  const file = interaction.options.getAttachment('file', true);
  const ext = path.extname(file.name || '').toLowerCase();

  if (!ALLOWED_EXT.includes(ext)) {
    return send(interaction, MESSAGES.badExt);
  }
  if (file.size > MAX_INPUT) {
    return send(interaction, MESSAGES.tooBig);
  }

  let buffer;
  try {
    const res = await fetch(file.url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error(err);
    return send(interaction, MESSAGES.download);
  }

  if (buffer.length === 0 || buffer.length > MAX_INPUT || buffer.includes(0)) {
    return send(interaction, MESSAGES.unsupported);
  }

  const source = buffer.toString('utf8').replace(/^\uFEFF/, '');

  await acquire();
  let result;
  try {
    result = await runDeobfuscator(source);
  } finally {
    release();
  }

  if (result.status === 'timeout') {
    return send(interaction, MESSAGES.timeout);
  }
  if (result.status !== 'ok') {
    return send(interaction, MESSAGES.unsupported);
  }

  const data = Buffer.from(result.output, 'utf8');
  if (data.length > MAX_OUTPUT) {
    return send(interaction, MESSAGES.outputTooBig);
  }

  const attachment = new AttachmentBuilder(data, { name: 'decoded.lua' });
  return send(interaction, { content: MESSAGES.done, files: [attachment] });
}

if (!TOKEN) {
  console.error('DISCORD_TOKEN is missing');
  process.exit(1);
}

if (!fs.existsSync(TOOL_PATH)) {
  console.error(`Deobfuscator tool not found at ${TOOL_PATH}`);
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (readyClient) => {
  try {
    await readyClient.application.commands.set(commands);
    console.log(`Logged in as ${readyClient.user.tag}, commands registered`);
  } catch (err) {
    console.error(err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'wdecode') {
    return;
  }

  try {
    await interaction.deferReply();
  } catch (err) {
    console.error(err);
    return;
  }

  try {
    await handleDecode(interaction);
  } catch (err) {
    console.error(err);
    await send(interaction, MESSAGES.internal);
  }
});

client.on(Events.Error, (err) => console.error(err));
process.on('unhandledRejection', (err) => console.error(err));
process.on('uncaughtException', (err) => console.error(err));

client.login(TOKEN);
