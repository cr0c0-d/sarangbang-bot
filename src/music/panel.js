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
        (audio.isPaused ? ' · ⏸️ 일시정지' : '')
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
      new ButtonBuilder()
        .setCustomId('m:refresh')
        .setEmoji('🔄')
        .setLabel('새로고침')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return rows;
}

/**
 * 제어판을 보여줍니다. 이미 띄워둔 제어판이 있으면 **새로 쌓지 않고 수정**합니다.
 * 곡이 바뀔 때마다 호출되므로, 이게 없으면 채팅방이 "재생 중" 메시지로 도배됩니다.
 */
export async function showPanel(audio, channel) {
  if (!channel) return;
  const body = buildPanel(audio);

  if (audio.panelMessage) {
    try {
      await audio.panelMessage.edit(body);
      return;
    } catch {
      // 메시지가 지워졌거나 너무 오래됐습니다. 아래에서 새로 보냅니다.
      audio.panelMessage = null;
    }
  }

  try {
    audio.panelMessage = await channel.send(body);
  } catch (err) {
    console.error('[music] 제어판 표시 실패:', err.message);
  }
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
