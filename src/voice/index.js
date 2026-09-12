// 🎧 `/음성기록` — 음성채널 대화의 지난 30초를 남깁니다.
//
// **방송 기록(`/방송`)과 별개 기능입니다.** 소유자 요청:
//   "기존 방송 기능과는 분리해줘. /음성기록 이런 별도의 명령어로 만들어줘"
//
// 처음에는 방송 제어판의 ✂️ 에 얹었는데, 주 용도가 **방송 없이 그냥 수다 떠는 상황**이라
// 그러면 수다를 떨려고 방송을 켜야 합니다. 기능 토글(`/기능`)도 따로여야 하고요.
//
// 명령어는 하나입니다. 인자 없이 실행하면 **상태 + 버튼 제어판**이 나옵니다 (3.6-6).
// 자주 누를 ✂️ 는 버튼이어야 합니다 — 명령어를 치는 동안 그 순간이 지나갑니다.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { config } from '../config.js';
import { get as getSetting, featureEnabled } from '../settings.js';
import { userError } from '../user-error.js';
import { getGuildAudio, peekGuildAudio } from '../audio/guild-audio.js';
import { rememberPanel, forgetPanel, rememberedPanels, VOICE } from '../panel-registry.js';
import { fmtBytes, cleanupByBudget } from '../stream/clips.js';
import { arm, disarm, isArmed, armedIn, bufferedInfo, saveLast, dropIfMoved } from './buffer.js';
import { addVoiceClip, allVoiceClips, clipsToday, folderFor } from './store.js';

const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });
const voicePageUrl = (guildId) => `${config.images.webPublicUrl}/v/${guildId}`;

/** 몇 분 몇 초 켜져 있었는지. */
function since(ms) {
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}초`;
  return `${Math.floor(sec / 60)}분 ${sec % 60}초`;
}

export function buildVoicePanel(guildId) {
  const state = isArmed(guildId) ? armedIn(guildId) : null;
  const today = clipsToday(guildId);
  const embed = new EmbedBuilder().setColor(state ? 0xe74c3c : 0x95a5a6);
  const lines = [];

  if (state) {
    const buf = bufferedInfo(guildId);
    embed.setTitle('🎙️ 소리 기록 중');
    lines.push(
      `<#${state.channelId}> · 켠 지 ${since(state.armedAt)}` +
        (state.reason === 'auto' ? ' · **자동으로 켜졌습니다**' : '')
    );
    lines.push(`지난 **${config.voice.clipSec}초**를 들고 있습니다 · 말한 사람 **${buf?.people ?? 0}명**`);
    lines.push('');
    lines.push('웃긴 순간에 **✂️ 지금 30초** 를 누르면 그 소리가 남습니다.');
    lines.push('-# 평소에는 메모리에만 있고 디스크에 남지 않습니다. 30초가 지나면 덮어씁니다.');
  } else {
    embed.setTitle('🎧 소리 기록');
    lines.push('음성채널 대화의 **지난 30초**를 뒤늦게 남기는 기능입니다.');
    lines.push('화면 녹화가 없어도 됩니다. 그냥 대화하다 웃긴 순간을 남기는 용도입니다.');
    lines.push('');
    const auto = getSetting(guildId, 'voiceRecordChannelIds');
    lines.push(
      auto?.length
        ? `${auto.map((id) => `<#${id}>`).join(' ')} 에 **${config.voice.autoMinPeople}명 이상** 모이면 저절로 켜집니다.\n` +
            '지금 바로 켜려면 음성채널에 들어가 **🎙️ 기록 켜기** 를 누르세요.'
        : '음성채널에 들어간 다음 **🎙️ 기록 켜기** 를 누르세요.\n' +
            '-# `/관리자 채널설정 종류:소리 기록 음성채널` 로 지정하면 사람이 모일 때 저절로 켜집니다.'
    );
  }

  if (today.length > 0) {
    lines.push('');
    lines.push(`오늘 남긴 소리 **${today.length}개** / ${config.voice.maxClips}개`);
  }
  embed.setDescription(lines.join('\n'));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('vc:toggle')
      .setLabel(state ? '기록 끄기' : '기록 켜기')
      .setEmoji(state ? '⏹️' : '🎙️')
      .setStyle(state ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('vc:save')
      .setLabel(`지금 ${config.voice.clipSec}초`)
      .setEmoji('✂️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!state)
  );

  const rows = [row];
  if (allVoiceClips(guildId).length > 0) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setEmoji('🎧')
          .setLabel('모든 소리 듣기')
          .setURL(voicePageUrl(guildId))
      )
    );
  }
  return { embeds: [embed], components: rows };
}

/** 상태가 바뀌면 이 서버에 떠 있는 제어판들을 고쳐 씁니다. */
export async function refreshVoicePanels(client, guildId) {
  for (const [channelId, messageId] of rememberedPanels(VOICE)) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel?.guildId && channel.guildId !== guildId) continue;
      const message = await channel.messages.fetch(messageId);
      await message.edit(buildVoicePanel(guildId));
    } catch (err) {
      if ([10003, 10008].includes(err.code)) forgetPanel(VOICE, channelId);
      else console.warn('[voice] 제어판 갱신 실패:', channelId, err.message);
    }
  }
}

async function toggle(interaction, client) {
  const guildId = interaction.guildId;
  if (isArmed(guildId)) {
    disarm(guildId, peekGuildAudio(guildId));
    await interaction.reply(eph('⏹️ 소리 기록을 껐습니다. 들고 있던 소리는 그대로 사라졌습니다.'));
    return refreshVoicePanels(client, guildId);
  }

  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    throw userError(
      '먼저 음성채널에 들어가 주세요.\n' +
        '켠 사람이 그 방에 있어야만 기록합니다 — 아무도 없는 방을 봇만 듣게 두지 않기 위해서입니다.'
    );
  }
  // 다른 방에서 노래가 돌고 있으면 `connect()` 가 봇을 이 방으로 **옮겨버립니다.**
  // 듣던 사람 입장에서는 그냥 끊깁니다.
  const busy = peekGuildAudio(guildId)?.connection?.joinConfig?.channelId;
  if (busy && busy !== channel.id) {
    throw userError(`망고가 지금 <#${busy}> 에 있습니다. 옮기면 거기서 듣던 소리가 끊기므로 옮기지 않았습니다.`);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const audio = getGuildAudio(channel.guild);
  await audio.connect(channel);
  const result = await arm(audio, channel, interaction.user.id);
  await interaction.editReply(
    `🎙️ **소리 기록을 켰습니다** — <#${channel.id}>\n` +
      `지난 **${config.voice.clipSec}초**를 들고 있습니다. 웃긴 순간에 **✂️** 만 누르세요.\n` +
      '-# 봇이 음성채널에 보입니다. 같이 있는 사람들에게 켰다고 알려주세요.' +
      (result.already ? '\n(이미 켜져 있었습니다)' : '')
  );
  return refreshVoicePanels(client, guildId);
}

async function saveNow(interaction, client) {
  const guildId = interaction.guildId;
  if (!isArmed(guildId)) return interaction.reply(eph('소리 기록이 꺼져 있습니다. 먼저 🎙️ 를 눌러주세요.'));

  const today = clipsToday(guildId);
  if (today.length >= config.voice.maxClips) {
    return interaction.reply(
      eph(`오늘 남긴 소리가 ${config.voice.maxClips}개를 넘었습니다. 내일 다시 쓸 수 있습니다.`)
    );
  }

  // ⚠️ **답을 먼저 합니다.** 디코딩·ffmpeg 로 몇 초 걸리는데, 여기서 기다리면
  //    가장 많이 눌리는 버튼이 3초를 넘겨 "Unknown interaction" 이 납니다.
  await interaction.reply(eph(`✂️ 지난 ${config.voice.clipSec}초를 남기고 있습니다…`));

  const folder = folderFor(guildId);
  let saved;
  try {
    saved = await saveLast(guildId, { folder });
  } catch (err) {
    // 원문을 그대로 보여줍니다. 원인을 추측하면 그 뒤로 진짜 원인을 못 찾습니다 (3.1-4).
    return interaction.editReply({ content: `🎙️ 소리를 저장하지 못했습니다: ${err.message}` });
  }
  if (!saved.ok) {
    if (saved.reason === 'off') return interaction.editReply({ content: '소리 기록이 꺼졌습니다.' });
    // ★ 수신이 막혀 있으면 **이 메시지가 그 신호입니다.** 빈 파일을 남기지 않습니다.
    return interaction.editReply({
      content:
        '🎙️ **받은 소리가 없어** 남기지 않았습니다.\n' +
        '정말 조용했다면 정상입니다. 계속 이러면 `/관리자 음성수신확인` 으로 수신 상태를 봐주세요.',
    });
  }

  addVoiceClip(guildId, {
    folder,
    file: saved.file,
    seconds: saved.seconds,
    bytes: saved.bytes,
    byUserId: interaction.user.id,
    speakers: saved.speakers,
  });
  await cleanupByBudget().catch((err) => console.warn('[voice] 예산 정리 실패:', err.message));
  // ⚠️ `editReply` 에는 Ephemeral 플래그를 넘기지 않습니다. 편집 API 는 그 플래그를
  //    받지 않고, 처음 `reply` 가 이미 나만 보기로 만들어 뒀습니다.
  await interaction.editReply({
    content:
      `🎧 **지난 ${saved.seconds}초를 남겼습니다** · 말한 사람 ${saved.speakers.length}명\n` +
      `${saved.file} · ${fmtBytes(saved.bytes)}\n\n모든 소리 보기·제목 바꾸기: ${voicePageUrl(guildId)}`,
  });
  return refreshVoicePanels(client, guildId);
}

// ── 자동으로 켜기 (사람이 들어오면 따라 들어감) ──────────────────

const humansIn = (channel) => [...(channel?.members?.values?.() ?? [])].filter((m) => !m.user.bot).length;

/** 이 음성채널이 자동 대상인가. **비워두면 아무 방도 아닙니다** (이미지 채널과 반대). */
function autoTarget(guildId, channelId) {
  const list = getSetting(guildId, 'voiceRecordChannelIds');
  return Array.isArray(list) && list.includes(channelId);
}

/**
 * 그 음성채널의 채팅에 제어판을 띄웁니다.
 *
 * 음성채널도 텍스트 채널입니다(3.4-1). 여기 띄워야 **웃긴 순간에 누를 버튼이 눈앞에**
 * 있습니다 — 자동으로 켜놓고 버튼이 딴 데 있으면 자동인 의미가 없습니다.
 */
async function ensurePanelIn(channel, guildId) {
  if (!channel?.isTextBased?.()) return;
  const known = rememberedPanels(VOICE).find(([channelId]) => channelId === channel.id);
  const payload = { ...buildVoicePanel(guildId), allowedMentions: { parse: [] } };
  if (known) {
    try {
      const message = await channel.messages.fetch(known[1]);
      await message.edit(payload);
      return;
    } catch (err) {
      if (err.code !== 10008) return void console.warn('[voice] 제어판 갱신 실패:', channel.id, err.message);
      forgetPanel(VOICE, channel.id);
    }
  }
  try {
    // 자동으로 뜨는 제어판이라 알림은 끕니다. 방에 들어올 때마다 울리면 곧 끄게 됩니다.
    const message = await channel.send({ ...payload, flags: MessageFlags.SuppressNotifications });
    rememberPanel(VOICE, channel.id, message.id);
  } catch (err) {
    console.warn('[voice] 제어판 표시 실패:', channel.id, err.message);
  }
}

/**
 * 음성채널 인원이 바뀔 때마다 불립니다. 켜고 끄는 판단이 전부 여기 있습니다.
 *
 * ★ **끄는 쪽을 먼저 봅니다.** 켜는 조건만 보면 사람이 빠져나간 뒤에도 계속 켜져 있습니다.
 */
export async function syncAutoVoiceRecord(client, oldState, newState) {
  const guildId = newState.guild.id;
  if (!config.voice.enabled || !featureEnabled(guildId, 'voice')) return;

  const audio = peekGuildAudio(guildId);
  const botChannelId = audio?.connection?.joinConfig?.channelId ?? null;

  // ⚠️ 읽어주기가 봇을 다른 방으로 옮겼을 수 있습니다. 그러면 두 방 소리가 섞입니다.
  if (dropIfMoved(guildId, botChannelId)) await refreshVoicePanels(client, guildId);

  const state = armedIn(guildId);
  if (state) {
    // 자동으로 켠 것만 자동으로 끕니다. 사람이 켠 것을 봇이 끄면 안 됩니다.
    const room = newState.guild.channels.cache.get(state.channelId);
    if (state.reason === 'auto' && humansIn(room) < config.voice.autoMinPeople) {
      disarm(guildId, audio);
      await refreshVoicePanels(client, guildId);
    }
    return;
  }

  const channel = newState.channel;
  if (!channel?.isVoiceBased?.() || !autoTarget(guildId, channel.id)) return;
  if (humansIn(channel) < config.voice.autoMinPeople) return;
  // 다른 방에서 뭔가 재생 중이면 옮기지 않습니다. 옮기면 듣던 사람 소리가 끊깁니다.
  if (botChannelId && botChannelId !== channel.id) return;

  try {
    const guildAudio = getGuildAudio(channel.guild);
    await guildAudio.connect(channel);
    await arm(guildAudio, channel, null, 'auto');
  } catch (err) {
    // 귀가 안 열리거나 권한이 없으면 켜지 않습니다. 원문을 남깁니다 (3.1-4).
    console.warn('[voice] 자동으로 켜지 못했습니다:', channel.id, err.message);
    return;
  }
  console.log(`[voice] 소리 기록을 자동으로 켰습니다 — ${channel.name} (${humansIn(channel)}명)`);
  await ensurePanelIn(channel, guildId);
  await refreshVoicePanels(client, guildId);
}

/** `vc:` 로 시작하는 버튼만 이 모듈이 받습니다. */
export function isVoiceComponent(customId) {
  return typeof customId === 'string' && customId.startsWith('vc:');
}

export async function handleVoiceComponent(interaction, client) {
  if (!config.voice.enabled) {
    return interaction.reply(
      eph(
        '소리 기록이 꺼져 있습니다. `.env` 에 `VOICE_RECORD=true` 를 넣어주세요.\n' +
          '⚠️ 먼저 `/관리자 음성수신확인` 으로 망고가 소리를 받을 수 있는지 확인하세요.'
      )
    );
  }
  if (interaction.customId === 'vc:toggle') return toggle(interaction, client);
  if (interaction.customId === 'vc:save') return saveNow(interaction, client);
  return interaction.reply(eph('알 수 없는 버튼입니다.'));
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('음성기록')
      .setDescription('음성채널 대화의 지난 30초를 남깁니다 (비우면 상태·버튼 보기)'),

    async execute(interaction) {
      if (!config.voice.enabled) {
        return interaction.reply(
          eph(
            '🎧 소리 기록이 꺼져 있습니다.\n' +
              '`.env` 에 `VOICE_RECORD=true` 를 넣고 봇을 다시 시작하세요.\n\n' +
              '⚠️ 망고가 음성채널 소리를 실제로 받을 수 있는지 **아직 확인되지 않았습니다.**\n' +
              '먼저 `/관리자 음성수신확인` 으로 확인해주세요.'
          )
        );
      }
      // 제어판은 이 채널에 **공개로** 둡니다. 눌러야 하는 사람이 여럿이고,
      // 웃긴 순간에 버튼이 눈앞에 있어야 하기 때문입니다.
      const message = await interaction.reply({ ...buildVoicePanel(interaction.guildId), withResponse: true });
      const sent = message?.resource?.message ?? (await interaction.fetchReply().catch(() => null));
      if (sent?.id) rememberPanel(VOICE, interaction.channelId, sent.id);
      return undefined;
    },
  },
];
