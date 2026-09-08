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
import { userError } from '../user-error.js';
import { getGuildAudio, peekGuildAudio } from '../audio/guild-audio.js';
import { rememberPanel, forgetPanel, rememberedPanels, VOICE } from '../panel-registry.js';
import { clipPageUrl, fmtBytes, cleanupByBudget } from '../stream/clips.js';
import { arm, disarm, isArmed, armedIn, bufferedInfo, saveLast } from './buffer.js';
import { addVoiceClip, clipsToday, folderFor, recentDays } from './store.js';

const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });

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
    lines.push(`<#${state.channelId}> · 켠 지 ${since(state.armedAt)}`);
    lines.push(`지난 **${config.voice.clipSec}초**를 들고 있습니다 · 말한 사람 **${buf?.people ?? 0}명**`);
    lines.push('');
    lines.push('웃긴 순간에 **✂️ 지금 30초** 를 누르면 그 소리가 남습니다.');
    lines.push('-# 평소에는 메모리에만 있고 디스크에 남지 않습니다. 30초가 지나면 덮어씁니다.');
  } else {
    embed.setTitle('🎧 소리 기록');
    lines.push('음성채널 대화의 **지난 30초**를 뒤늦게 남기는 기능입니다.');
    lines.push('화면 녹화가 없어도 됩니다. 그냥 대화하다 웃긴 순간을 남기는 용도입니다.');
    lines.push('');
    lines.push('음성채널에 들어간 다음 **🎙️ 켜기** 를 누르세요.');
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
  const days = recentDays(guildId, 3);
  if (days.length > 0) {
    rows.push(
      new ActionRowBuilder().addComponents(
        ...days.map((d, i) =>
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setEmoji('🎧')
            .setLabel(i === 0 && d.folder === folderFor(guildId) ? '오늘 들으러 가기' : `${d.folder.slice(-4)} 듣기`)
            .setURL(clipPageUrl(d.folder))
        )
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
    return interaction.editReply(eph(`🎙️ 소리를 저장하지 못했습니다: ${err.message}`));
  }
  if (!saved.ok) {
    if (saved.reason === 'off') return interaction.editReply(eph('소리 기록이 꺼졌습니다.'));
    // ★ 수신이 막혀 있으면 **이 메시지가 그 신호입니다.** 빈 파일을 남기지 않습니다.
    return interaction.editReply(
      eph(
        '🎙️ **받은 소리가 없어** 남기지 않았습니다.\n' +
          '정말 조용했다면 정상입니다. 계속 이러면 `/관리자 음성수신확인` 으로 수신 상태를 봐주세요.'
      )
    );
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
  await interaction.editReply(
    eph(
      `🎧 **지난 ${saved.seconds}초를 남겼습니다** · 말한 사람 ${saved.speakers.length}명\n` +
        `${saved.file} · ${fmtBytes(saved.bytes)}\n\n듣기: ${clipPageUrl(folder)}`
    )
  );
  return refreshVoicePanels(client, guildId);
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
