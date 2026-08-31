// TTS 타이머 — 시간이 되면 음성채널에서 소리로 알려줍니다.
//
// 설계 메모:
//   - 서버를 재시작해도 타이머가 살아남아야 합니다. 배포할 때마다 재시작되므로
//     메모리에만 두면 60분 타이머가 사라집니다. 그래서 data/timers.json 에 저장하고
//     시작할 때 되살립니다. 이미 지난 것은 즉시 알리고 "늦었다" 고 밝힙니다.
//   - 자주 쓰는 시간을 **단어로 등록**할 수 있습니다 (예: "라면" = 3분).
//     등록한 단어는 /타이머 의 자동완성에 같이 나와서 외울 필요가 없습니다.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { config } from '../config.js';
import { get as getSetting } from '../settings.js';
import { getGuildAudio, peekGuildAudio } from '../audio/guild-audio.js';
import { synthesize } from '../tts/synth.js';

const FILE = path.join(config.dataDir, 'timers.json');

/** 기본 프리셋 (분). 등록한 단어가 없어도 바로 쓸 수 있게. */
const PRESETS = [1, 3, 5, 10, 15, 30, 45, 60];
/** 타이머 최대 길이. setTimeout 한계(약 24.8일)보다 훨씬 짧게 잡아 안전하게 둡니다. */
const MAX_MINUTES = 24 * 60;

/** @type {{words: Record<string, Record<string, number>>, running: object[]}} */
let store = { words: {}, running: {} };
let writeChain = Promise.resolve();
/** 실행 중인 setTimeout 핸들. 저장하지 않습니다. */
const handles = new Map();
let discordClient = null;

function save() {
  writeChain = writeChain
    .then(() => fs.writeFile(FILE, JSON.stringify(store, null, 2), 'utf8'))
    .catch((e) => console.error('[timer] 저장 실패:', e.message));
  return writeChain;
}

// ── 시간 해석 ────────────────────────────────────────────────

/**
 * 사람이 쓰는 표현을 분으로 바꿉니다.
 * "15" "15분" "1시간" "1시간 30분" "90m" "1h30m" 모두 받습니다.
 * @returns {number|null} 분. 못 읽으면 null
 */
export function parseMinutes(input) {
  const s = String(input ?? '')
    .toLowerCase()
    .replace(/\s+/g, '');
  if (!s) return null;

  // 숫자만 있으면 분으로 봅니다.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 0 ? n : null;
  }

  let total = 0;
  let matched = false;
  const hour = s.match(/(\d+(?:\.\d+)?)\s*(?:시간|시|h)/);
  if (hour) {
    total += Number(hour[1]) * 60;
    matched = true;
  }
  const min = s.match(/(\d+(?:\.\d+)?)\s*(?:분|m)(?!\w)/);
  if (min) {
    total += Number(min[1]);
    matched = true;
  }
  const sec = s.match(/(\d+(?:\.\d+)?)\s*(?:초|s)(?!\w)/);
  if (sec) {
    total += Number(sec[1]) / 60;
    matched = true;
  }
  if (!matched || total <= 0) return null;
  return total;
}

export function formatMinutes(min) {
  const total = Math.round(min * 60); // 초
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h) parts.push(`${h}시간`);
  if (m) parts.push(`${m}분`);
  if (s && !h) parts.push(`${s}초`);
  return parts.join(' ') || '0초';
}

// ── 등록한 단어 ──────────────────────────────────────────────

export function words(guildId) {
  return store.words[guildId] ?? {};
}

export function setWord(guildId, word, minutes) {
  store.words[guildId] ??= {};
  store.words[guildId][word] = minutes;
  save();
}

export function removeWord(guildId, word) {
  if (!store.words[guildId]?.[word]) return false;
  delete store.words[guildId][word];
  if (Object.keys(store.words[guildId]).length === 0) delete store.words[guildId];
  save();
  return true;
}

// ── 타이머 ───────────────────────────────────────────────────

export function running(guildId) {
  return Object.values(store.running).filter((t) => t.guildId === guildId).sort((a, b) => a.fireAt - b.fireAt);
}

function schedule(timer) {
  const delay = Math.max(0, timer.fireAt - Date.now());
  const h = setTimeout(() => fire(timer.id), delay);
  h.unref?.();
  handles.set(timer.id, h);
}

export function addTimer({ guildId, channelId, userId, label, minutes, voiceChannelId }) {
  const id = `${Date.now().toString(36)}-${Math.floor(performance.now() * 1000) % 100000}`;
  const timer = {
    id,
    guildId,
    channelId,
    userId,
    voiceChannelId: voiceChannelId ?? null,
    label: label ?? null,
    minutes,
    fireAt: Date.now() + minutes * 60_000,
  };
  store.running[id] = timer;
  save();
  schedule(timer);
  return timer;
}

export function cancelTimer(id) {
  const timer = store.running[id];
  if (!timer) return null;
  clearTimeout(handles.get(id));
  handles.delete(id);
  delete store.running[id];
  save();
  return timer;
}

/** 시간이 됐을 때. 음성으로 알리고 채팅으로도 남깁니다. */
async function fire(id, lateBy = 0) {
  const timer = store.running[id];
  if (!timer) return;
  delete store.running[id];
  handles.delete(id);
  save();

  const what = timer.label ? `**${timer.label}**` : `${formatMinutes(timer.minutes)}`;
  const lateNote =
    lateBy > 60_000 ? `\n(봇이 꺼져 있어 ${formatMinutes(lateBy / 60_000)} 늦게 알렸습니다)` : '';

  try {
    const channel = await discordClient?.channels?.fetch(timer.channelId).catch(() => null);
    // 알람은 알림이 울려야 의미가 있으므로 멘션을 붙입니다. (제어판과 반대)
    await channel
      ?.send(`⏰ <@${timer.userId}> ${what} 타이머가 끝났습니다.${lateNote}`)
      .catch(() => {});

    await speakAlarm(timer);
  } catch (err) {
    console.error('[timer] 알림 실패:', err.message);
  }
}

/** 음성채널에서 소리로 알립니다. 아무도 없거나 실패하면 조용히 넘어갑니다. */
async function speakAlarm(timer) {
  const guild = await discordClient?.guilds?.fetch(timer.guildId).catch(() => null);
  if (!guild) return;

  // 타이머를 걸 때 있던 음성채널 → 설정된 TTS 음성채널 → 그중 아무것도 없으면 포기
  const candidates = [timer.voiceChannelId, getSetting(timer.guildId, 'ttsVoiceChannelId')].filter(Boolean);
  let voiceChannel = null;
  for (const id of candidates) {
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (ch?.isVoiceBased?.()) {
      voiceChannel = ch;
      break;
    }
  }
  if (!voiceChannel) return;

  const what = timer.label ? timer.label : formatMinutes(timer.minutes);
  const text = `${what} 타이머가 끝났습니다.`;

  try {
    const audio = getGuildAudio(guild);
    await audio.connect(voiceChannel);
    const voice = config.tts.voice;
    audio.speak(() => synthesize(text, voice), voiceChannel.id);
  } catch (err) {
    console.error('[timer] 음성 알림 실패:', err.message);
  }
}

/** 봇 시작 시 호출. 저장된 타이머를 되살립니다. */
export async function initTimers(client) {
  discordClient = client;
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const loaded = JSON.parse(await fs.readFile(FILE, 'utf8'));
    store = { words: loaded.words ?? {}, running: loaded.running ?? {} };
  } catch {
    store = { words: {}, running: {} };
  }

  const now = Date.now();
  let restored = 0;
  let overdue = 0;
  for (const timer of Object.values(store.running)) {
    if (timer.fireAt <= now) {
      // 봇이 꺼져 있는 동안 시간이 지났습니다. 지금 알려주되 늦었다고 밝힙니다.
      overdue++;
      setTimeout(() => fire(timer.id, now - timer.fireAt), 3_000).unref?.();
    } else {
      schedule(timer);
      restored++;
    }
  }
  if (restored || overdue) {
    console.log(`   타이머 복구: 진행중 ${restored}개${overdue ? `, 이미 지난 것 ${overdue}개` : ''}`);
  }
}

// ── 슬래시 명령어 ────────────────────────────────────────────

function timerListEmbed(guildId) {
  const list = running(guildId);
  const embed = new EmbedBuilder().setTitle('⏰ 진행 중인 타이머').setColor(0x5865f2);
  if (list.length === 0) {
    embed.setDescription('진행 중인 타이머가 없습니다.\n`/타이머 15분` 처럼 걸어보세요.');
    return { embeds: [embed], components: [] };
  }
  embed.setDescription(
    list
      .map((t) => {
        const left = Math.max(0, t.fireAt - Date.now()) / 60_000;
        const name = t.label ?? formatMinutes(t.minutes);
        // <t:초:R> 는 디스코드가 "3분 후" 처럼 알아서 보여주는 상대시간 표시입니다.
        return `• **${name}** — <t:${Math.floor(t.fireAt / 1000)}:R> (${formatMinutes(left)} 남음)`;
      })
      .join('\n')
  );

  // 버튼은 한 줄에 5개, 최대 5줄까지 가능합니다. 여기선 최대 10개만 취소 버튼을 붙입니다.
  const rows = [];
  for (let i = 0; i < Math.min(list.length, 10); i += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(
        list.slice(i, i + 5).map((t) =>
          new ButtonBuilder()
            .setCustomId(`t:cancel:${t.id}`)
            .setLabel(`❌ ${(t.label ?? formatMinutes(t.minutes)).slice(0, 20)}`)
            .setStyle(ButtonStyle.Secondary)
        )
      )
    );
  }
  return { embeds: [embed], components: rows };
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('타이머')
      .setDescription('시간이 되면 음성으로 알려줍니다')
      .addStringOption((o) =>
        o
          .setName('시간')
          .setDescription('예: 15분, 1시간 30분, 또는 등록한 단어 (라면)')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((o) =>
        o.setName('이름').setDescription('알림에 읽어줄 이름 (비우면 시간을 읽어줍니다)').setRequired(false)
      ),
    /** 자동완성: 프리셋 + 이 서버에 등록된 단어를 같이 보여줍니다. */
    async autocomplete(interaction) {
      const typed = interaction.options.getFocused().trim();
      const registered = Object.entries(words(interaction.guildId)).map(([w, m]) => ({
        name: `${w} — ${formatMinutes(m)}`,
        value: w,
      }));
      const presets = PRESETS.map((m) => ({ name: formatMinutes(m), value: `${m}분` }));

      let list = [...registered, ...presets];
      if (typed) {
        const lower = typed.toLowerCase();
        list = list.filter((c) => c.name.toLowerCase().includes(lower) || c.value.includes(typed));
        // 직접 입력한 값이 시간으로 읽히면 그것도 후보로 올려줍니다.
        const parsed = parseMinutes(typed);
        if (parsed) list.unshift({ name: `${formatMinutes(parsed)} 뒤`, value: typed });
      }
      await interaction.respond(list.slice(0, 25)).catch(() => {});
    },
    async execute(interaction) {
      const raw = interaction.options.getString('시간');
      const registered = words(interaction.guildId);

      // 등록한 단어가 먼저입니다. "라면" 처럼 시간으로 안 읽히는 값도 받아들이려면 이 순서여야 합니다.
      const fromWord = registered[raw];
      const minutes = fromWord ?? parseMinutes(raw);

      if (!minutes) {
        return interaction.reply({
          content:
            `"${raw}" 를 시간으로 읽지 못했습니다.\n` +
            '`15분`, `1시간 30분` 처럼 쓰거나, `/알람등록` 으로 단어를 먼저 등록해주세요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (minutes > MAX_MINUTES) {
        return interaction.reply({
          content: `타이머는 최대 ${formatMinutes(MAX_MINUTES)} 까지만 걸 수 있습니다.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const label = interaction.options.getString('이름') ?? (fromWord ? raw : null);
      const timer = addTimer({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        label,
        minutes,
        voiceChannelId: interaction.member?.voice?.channel?.id ?? null,
      });

      const name = label ? `**${label}** (${formatMinutes(minutes)})` : `**${formatMinutes(minutes)}**`;
      const where = timer.voiceChannelId ? '' : '\n(음성채널에 들어가 있으면 소리로도 알려줍니다)';
      await interaction.reply(`⏰ ${name} 타이머를 걸었습니다. <t:${Math.floor(timer.fireAt / 1000)}:R>${where}`);
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('타이머목록')
      .setDescription('진행 중인 타이머를 보고 버튼으로 취소합니다'),
    async execute(interaction) {
      await interaction.reply({ ...timerListEmbed(interaction.guildId), flags: MessageFlags.Ephemeral });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('알람등록')
      .setDescription('자주 쓰는 시간을 단어로 등록합니다 (예: 라면 = 3분)')
      .addStringOption((o) => o.setName('단어').setDescription('예: 라면').setRequired(true))
      .addStringOption((o) =>
        o.setName('시간').setDescription('예: 3분 · 지우려면 "삭제" 라고 쓰세요').setRequired(true)
      ),
    async execute(interaction) {
      const word = interaction.options.getString('단어').trim().slice(0, 30);
      const timeRaw = interaction.options.getString('시간').trim();

      if (['삭제', '제거', '0', 'delete', 'remove'].includes(timeRaw)) {
        const ok = removeWord(interaction.guildId, word);
        return interaction.reply(
          ok ? `🗑️ **${word}** 알람을 지웠습니다.${wordListText(interaction.guildId)}` : `**${word}** 은(는) 등록되어 있지 않습니다.`
        );
      }

      const minutes = parseMinutes(timeRaw);
      if (!minutes) {
        return interaction.reply({
          content: `"${timeRaw}" 를 시간으로 읽지 못했습니다. \`3분\`, \`1시간 30분\` 처럼 써주세요.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      if (minutes > MAX_MINUTES) {
        return interaction.reply({
          content: `최대 ${formatMinutes(MAX_MINUTES)} 까지만 등록할 수 있습니다.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      setWord(interaction.guildId, word, minutes);
      await interaction.reply(
        `✅ **${word}** = ${formatMinutes(minutes)} 로 등록했습니다.\n` +
          `이제 \`/타이머 ${word}\` 로 쓸 수 있습니다.${wordListText(interaction.guildId)}`
      );
    },
  },
];

function wordListText(guildId) {
  const w = words(guildId);
  const keys = Object.keys(w);
  if (keys.length === 0) return '';
  return '\n\n**등록된 알람**\n' + keys.map((k) => `• ${k} — ${formatMinutes(w[k])}`).join('\n');
}

/** 타이머 취소 버튼 처리. customId 가 `t:` 으로 시작하는 것만 옵니다. */
export async function handleTimerComponent(interaction) {
  const [, action, id] = interaction.customId.split(':');
  if (action !== 'cancel') return;

  const timer = cancelTimer(id);
  const name = timer ? (timer.label ?? formatMinutes(timer.minutes)) : null;
  await interaction.update(timerListEmbed(interaction.guildId)).catch(() => {});
  if (name) {
    await interaction
      .followUp({ content: `❌ **${name}** 타이머를 취소했습니다.`, flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }
}
