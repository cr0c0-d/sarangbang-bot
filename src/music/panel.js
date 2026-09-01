// 음악 제어판 — 버튼과 드롭다운으로 대기열을 관리합니다.
//
// 왜 버튼인가: 이 봇은 프로그래밍을 모르는 친구들이 함께 씁니다.
// `/순서이동 3 1` 같은 명령을 외우게 하면 아무도 안 씁니다.
// 그래서 "지금 재생 중" 메시지에 버튼을 붙이고, 곡이 바뀌면
// 새 메시지를 쌓지 않고 **그 메시지를 수정**합니다 (채팅방이 안 더러워짐).
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} from 'discord.js';
import { formatDuration } from './ytdlp.js';
import { volumePercent, setVolume } from '../settings.js';
import { rememberPanel, forgetPanel, MUSIC } from '../panel-registry.js';

// 드롭다운은 디스코드 제한으로 최대 25개까지만 담을 수 있습니다.
const SELECT_LIMIT = 25;

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** 제어판 메시지 본문(임베드 + 버튼)을 만듭니다. */
export function buildPanel(audio) {
  const embed = new EmbedBuilder().setColor(0x5865f2);

  if (audio?.current) {
    const t = audio.current.track;
    embed.setTitle('🎵 지금 재생 중');
    embed.setDescription(
      `**${cut(t.title, 200)}**\n${formatDuration(t.duration)}` +
        (audio.loop ? ' · 🔁 반복' : '') +
        (audio.isPaused ? ' · ⏸️ 일시정지' : '') +
        ` · 🔊 ${volumePercent(audio.guild?.id, 'music')}%`
    );
    if (t.thumbnail) embed.setThumbnail(t.thumbnail);
  } else {
    embed.setTitle('🎵 재생 중인 곡이 없습니다');
    embed.setDescription('유튜브 링크를 붙여넣거나 `/재생 <검색어>` 를 써보세요.');
  }

  const q = audio?.queue ?? [];
  if (q.length > 0) {
    const lines = q
      .slice(0, 10)
      .map((it, i) => `\`${i + 1}.\` ${cut(it.track.title, 60)} (${formatDuration(it.track.duration)})`)
      .join('\n');
    embed.addFields({
      name: `📃 대기열 ${q.length}곡`,
      value: lines + (q.length > 10 ? `\n… 외 ${q.length - 10}곡` : ''),
    });
  }

  return { embeds: [embed], components: buildComponents(audio) };
}

function buildComponents(audio) {
  const playing = Boolean(audio?.current);
  const q = audio?.queue ?? [];
  const rows = [];

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('m:prev')
        .setEmoji('⏮️')
        .setLabel('이전')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!audio || audio.history.length === 0),
      new ButtonBuilder()
        .setCustomId('m:toggle')
        .setEmoji(audio?.isPaused ? '▶️' : '⏸️')
        .setLabel(audio?.isPaused ? '재생' : '일시정지')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!playing),
      new ButtonBuilder()
        .setCustomId('m:next')
        .setEmoji('⏭️')
        .setLabel('다음')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!playing && q.length === 0),
      new ButtonBuilder()
        .setCustomId('m:loop')
        .setEmoji('🔁')
        .setLabel('반복')
        .setStyle(audio?.loop ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!playing),
      new ButtonBuilder()
        .setCustomId('m:stop')
        .setEmoji('⏹️')
        .setLabel('정지')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!playing && q.length === 0)
    )
  );

  if (q.length > 0) {
    const options = q.slice(0, SELECT_LIMIT).map((it, i) => ({
      label: cut(`${i + 1}. ${it.track.title}`, 100),
      value: String(i + 1),
      description: formatDuration(it.track.duration),
    }));

    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('m:top')
          .setPlaceholder('⬆️ 이 곡을 다음에 재생하기')
          .addOptions(options)
      )
    );
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('m:del')
          .setPlaceholder('🗑️ 대기열에서 빼기')
          .addOptions(options)
      )
    );
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('m:vol-').setEmoji('🔉').setLabel('소리 -10').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('m:vol+').setEmoji('🔊').setLabel('소리 +10').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('m:hist')
        .setEmoji('🕐')
        .setLabel('지난 곡')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('m:refresh')
        .setEmoji('🔄')
        .setLabel('새로고침')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return rows;
}

/** 이 메시지가 채팅방의 가장 마지막 메시지인지 확인합니다. */
async function isAtBottom(channel, messageId) {
  try {
    const last = await channel.messages.fetch({ limit: 1 });
    return last.first()?.id === messageId;
  } catch {
    return false; // 확인 못 하면 안전하게 "아니다" 로 봅니다
  }
}

/**
 * 제어판을 **항상 채팅방의 가장 아래**에 보여줍니다.
 *
 * 규칙:
 *   - 제어판이 이미 맨 아래면 → 그 메시지를 **수정**만 합니다 (채팅방이 안 더러워짐)
 *   - 다른 메시지에 밀려 위로 올라갔으면 → **지우고 맨 아래에 다시** 띄웁니다
 *   - 새로 보낼 때는 SuppressNotifications 를 붙여 **알림이 울리지 않게** 합니다
 *
 * 동시에 여러 번 불릴 수 있어(곡 추가 + 곡 전환이 겹칠 때) 서버별로 줄을 세웁니다.
 * 안 그러면 제어판이 두 개 생깁니다.
 */
export function showPanel(audio, channel) {
  if (!channel || !audio) return Promise.resolve();
  audio.panelChain = (audio.panelChain ?? Promise.resolve())
    .then(() => showPanelNow(audio, channel))
    .catch((err) => console.error('[music] 제어판 표시 실패:', err.message));
  return audio.panelChain;
}

async function showPanelNow(audio, channel) {
  if (audio.destroyed) return;

  if (audio.panelMessage) {
    if (await isAtBottom(channel, audio.panelMessage.id)) {
      try {
        await audio.panelMessage.edit(buildPanel(audio));
        return;
      } catch {
        audio.panelMessage = null; // 지워졌거나 수정 불가 → 아래에서 새로 보냅니다
        forgetPanel(MUSIC, channel.id);
      }
    } else {
      // 위로 밀려났습니다. 옛 제어판을 지우고 맨 아래에 다시 띄웁니다.
      await audio.panelMessage.delete().catch(() => {});
      audio.panelMessage = null;
      forgetPanel(MUSIC, channel.id);
    }
  }

  audio.panelMessage = await channel.send({
    ...buildPanel(audio),
    // @silent 메시지 — 채팅방에 나타나지만 푸시 알림은 울리지 않습니다.
    flags: MessageFlags.SuppressNotifications,
  });
  // 재시작 후에도 이 제어판을 찾아 지울 수 있도록 디스크에 적어둡니다.
  rememberPanel(MUSIC, channel.id, audio.panelMessage.id);
}

/** 버튼·드롭다운 클릭 처리. customId 가 `m:` 으로 시작하는 것만 옵니다. */
export async function handleMusicComponent(interaction, audio) {
  if (!audio) {
    return interaction.reply({
      content: '재생 중인 곡이 없습니다. 유튜브 링크를 붙여넣어 보세요.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const id = interaction.customId;
  let toast = null;

  switch (id) {
    case 'm:prev': {
      if (!audio.previous()) toast = '되돌아갈 이전 곡이 없습니다.';
      break;
    }
    case 'm:toggle': {
      if (audio.isPaused) audio.resume();
      else audio.pause();
      break;
    }
    case 'm:next': {
      audio.skip();
      break;
    }
    case 'm:loop': {
      audio.loop = !audio.loop;
      break;
    }
    case 'm:stop': {
      audio.stop();
      break;
    }
    case 'm:refresh':
      break;
    case 'm:vol-':
    case 'm:vol+': {
      const step = id === 'm:vol+' ? 10 : -10;
      const now = setVolume(audio.guild.id, 'music', volumePercent(audio.guild.id, 'music') + step);
      // 재생 중이면 듣던 지점부터 다시 틀어 바로 반영합니다.
      audio.reapplyVolume();
      toast = `🔊 음악 음량 **${now}%** — 듣던 곳에서 곧 바뀝니다.`;
      break;
    }
    case 'm:top': {
      const pos = Number(interaction.values[0]);
      const item = audio.bringToFront(pos);
      toast = item ? `⬆️ **${item.track.title}** 를 다음 곡으로 올렸습니다.` : '그 곡을 찾지 못했습니다.';
      break;
    }
    case 'm:del': {
      const pos = Number(interaction.values[0]);
      const item = audio.removeAt(pos);
      toast = item ? `🗑️ **${item.track.title}** 를 대기열에서 뺐습니다.` : '그 곡을 찾지 못했습니다.';
      break;
    }
    default:
      return;
  }

  // 버튼을 누른 그 메시지를 최신 상태로 갱신합니다.
  // 곡을 넘긴 직후에는 아직 다음 곡이 로딩 중일 수 있어 살짝 기다립니다.
  if (id === 'm:prev' || id === 'm:next') await new Promise((r) => setTimeout(r, 400));

  audio.panelMessage = interaction.message;
  rememberPanel(MUSIC, interaction.channelId, interaction.message.id);
  try {
    await interaction.update(buildPanel(audio));
  } catch (err) {
    console.error('[music] 제어판 갱신 실패:', err.message);
    return;
  }

  if (toast) {
    await interaction.followUp({ content: toast, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}
