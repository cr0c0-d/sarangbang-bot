// 관리자용 방송 기록 조회.
//
// 기록은 180일 보존되는 streams.json을 그대로 읽습니다. 별도 복사본을 만들면 실제 타임라인과
// 관리자 목록의 상태가 어긋나므로, 화면을 열거나 넘길 때마다 현재 저장소에서 다시 계산합니다.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  sessionsForGuild,
  sessionById,
  restoreStreamGame,
  setStreamForumPosted,
  setStreamGame,
  streamOf,
  timelineFor,
} from './store.js';
import { postIdFor } from '../game/store.js';
import { rememberGame } from '../game/catalog.js';
import { resolveGame } from '../game/steam.js';
import { publishStreamRecord } from '../game/forum.js';
import { symbolMention } from '../settings.js';
import { buildSummary } from './panel.js';
import { userError } from '../user-error.js';

const PAGE_SIZE = 8;
const FILTERS = new Set(['attention', 'all', 'live', 'complete']);
const FILTER_LABEL = {
  attention: '확인 필요',
  all: '전체 기록',
  live: '진행 중',
  complete: '정리 완료',
};

const cut = (value, length) => {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};

/** 한 방송의 현재 연결·게시 상태. 목록과 검증이 같은 판정을 공유합니다. */
export function streamRecordState(session, stream) {
  const endedAt = stream.endedAt || session.closedAt || null;
  const live = !endedAt;
  const forumThreadId = stream.forumPosted?.threadId ||
    (stream.gameKey ? postIdFor(session.guildId, 'rec', stream.gameKey) : null);
  const messageIds = stream.forumPosted?.messageIds ?? [];
  const postedComplete = messageIds.length > 0 && stream.forumPosted?.complete !== false;
  const complete = !live && Boolean(stream.url) && postedComplete;
  const labels = [];
  if (live) labels.push('🔴 진행 중');
  else {
    if (!stream.url) labels.push('🔗 다시보기 미연결');
    if (!forumThreadId) labels.push('🟠 녹화방 미연결');
    else if (!messageIds.length) labels.push('🟡 녹화방 게시 대기');
    else if (!postedComplete) labels.push('⚠️ 게시 복구 필요');
    if (complete) labels.push('✅ 정리 완료');
  }
  return {
    live,
    complete,
    attention: !live && !complete,
    endedAt,
    forumThreadId,
    labels,
  };
}

function recordsFor(guildId, filter) {
  const records = sessionsForGuild(guildId).flatMap((session) =>
    session.streams.map((stream) => ({ session, stream, state: streamRecordState(session, stream) }))
  ).sort((a, b) => (b.state.endedAt || b.session.openedAt) - (a.state.endedAt || a.session.openedAt));
  if (filter === 'live') return records.filter((item) => item.state.live);
  if (filter === 'complete') return records.filter((item) => item.state.complete);
  if (filter === 'attention') return records.filter((item) => item.state.attention);
  return records;
}

/** Discord 제한 안에서 관리자 목록 한 페이지를 만듭니다. */
export function buildAdminRecordList(guildId, filter = 'attention', page = 0) {
  const selectedFilter = FILTERS.has(filter) ? filter : 'attention';
  const records = recordsFor(guildId, selectedFilter);
  const pages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const current = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const shown = records.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);
  const lines = shown.map(({ session, stream, state }, index) => {
    const number = current * PAGE_SIZE + index + 1;
    const game = stream.game || session.game || '게임 미지정';
    const marks = timelineFor(session, stream).length;
    return `**${number}. ${cut(game, 45)}** · ${symbolMention(guildId, stream.userId)} · <t:${stream.startedAt || session.openedAt}:d>\n` +
      `　${state.labels.join(' · ')} · 타임라인 ${marks}개`;
  });

  const filterSelect = new StringSelectMenuBuilder()
    .setCustomId('tm:adminrecordfilter')
    .setPlaceholder('표시할 방송 기록 상태')
    .addOptions(
      { label: '확인 필요', description: '종료 후 연결·게시가 덜 끝난 기록', value: 'attention', default: selectedFilter === 'attention' },
      { label: '전체 기록', description: '보관 중인 모든 방송', value: 'all', default: selectedFilter === 'all' },
      { label: '진행 중', description: '아직 종료되지 않은 방송', value: 'live', default: selectedFilter === 'live' },
      { label: '정리 완료', description: '다시보기와 녹화방 게시가 완료된 방송', value: 'complete', default: selectedFilter === 'complete' },
    );
  const components = [new ActionRowBuilder().addComponents(filterSelect)];
  if (shown.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`tm:adminrecordpick:${selectedFilter}:${current}`)
        .setPlaceholder('자세히 볼 방송 고르기')
        .addOptions(shown.map(({ session, stream, state }) => ({
          label: cut(stream.game || session.game || '게임 미지정', 80),
          description: cut(`${state.labels.join(' · ')} · ${new Date((stream.startedAt || session.openedAt) * 1000).toLocaleDateString('ko-KR')}`, 100),
          value: `${session.id}:${stream.userId}`,
        })))
    ));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tm:adminrecords:${selectedFilter}:${current - 1}`)
      .setLabel('이전').setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
    new ButtonBuilder().setCustomId(`tm:adminrecords:${selectedFilter}:${current}`)
      .setLabel('새로고침').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tm:adminrecords:${selectedFilter}:${current + 1}`)
      .setLabel('다음').setStyle(ButtonStyle.Secondary).setDisabled(current >= pages - 1),
  ));

  return {
    content: `📚 **방송 기록 · ${FILTER_LABEL[selectedFilter]}** — ${records.length}개 · ${current + 1}/${pages}쪽\n\n` +
      (lines.length ? lines.join('\n\n') : '이 상태에 해당하는 방송 기록이 없습니다.') +
      '\n\n기록은 최근 180일 동안 보관됩니다. 항목을 고르면 다시보기 연결과 타임라인 편집도 할 수 있습니다.',
    components,
    allowedMentions: { parse: [] },
  };
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function gameEditRow(session, stream) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tm:adminrecordgame:${session.id}:${stream.userId}`)
      .setLabel('게임 연결 수정')
      .setEmoji('🎮')
      .setStyle(ButtonStyle.Secondary)
  );
}

/** 관리자 상세 요약 마지막 장에만 게임 연결 수정 버튼을 붙입니다. */
export function buildAdminRecordDetail(session, stream, notice = '') {
  const pages = buildSummary(session, stream).map((page) => ({ ...page }));
  const last = pages[pages.length - 1];
  last.content = notice ? `${notice}\n\n${last.content}` : last.content;
  last.components = [...(last.components ?? []), gameEditRow(session, stream)];
  return pages;
}

function openGameEditModal(interaction, sessionId, userId) {
  const session = sessionById(sessionId);
  const stream = session?.guildId === interaction.guildId ? streamOf(session, userId) : null;
  if (!stream) return interaction.reply({ content: '그 방송 기록을 찾지 못했습니다.', flags: MessageFlags.Ephemeral });
  const input = new TextInputBuilder()
    .setCustomId('game')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100)
    .setPlaceholder('게임 이름·별칭 또는 Steam 상점 주소');
  if (stream.game) input.setValue(stream.game.slice(0, 100));
  return interaction.showModal(
    new ModalBuilder()
      .setCustomId(`tm:adminrecordgamem:${session.id}:${stream.userId}`)
      .setTitle('방송 기록의 게임 연결 수정')
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('연결할 게임')
          .setDescription('녹화방 포스트에 이미 연결된 게임을 입력하세요')
          .setTextInputComponent(input)
      )
  );
}

async function deleteOldRecordMessages(client, forumPosted) {
  if (!forumPosted?.threadId || !forumPosted.messageIds?.length) return true;
  const thread = await client.channels.fetch(forumPosted.threadId).catch(() => null);
  if (!thread?.isTextBased?.()) return false;
  let complete = true;
  for (const id of forumPosted.messageIds) {
    try { await thread.messages.delete(id); }
    catch (err) { if (err.code !== 10008) complete = false; }
  }
  return complete;
}

function gameInputKey(raw) {
  const text = String(raw ?? '').trim();
  const steamUrl = text.match(/store\.steampowered\.com\/app\/(\d+)/i);
  return steamUrl ? `steam:${steamUrl[1]}` : text;
}

/** 게임 수정 모달 제출. 새 녹화방 게시 성공 전에는 이전 게시물을 지우지 않습니다. */
export async function handleAdminRecordModal(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: '서버 관리자만 방송 기록을 수정할 수 있습니다.', flags: MessageFlags.Ephemeral });
  }
  const [, , sessionId, userId] = interaction.customId.split(':');
  const session = sessionById(sessionId);
  const stream = session?.guildId === interaction.guildId ? streamOf(session, userId) : null;
  if (!stream) return interaction.reply({ content: '그 방송 기록을 찾지 못했습니다.', flags: MessageFlags.Ephemeral });

  const raw = interaction.fields.getTextInputValue('game');
  const game = await resolveGame(gameInputKey(raw), interaction.guildId);
  if (!game) throw userError('게임을 확인하지 못했습니다. 게임 이름·별칭 또는 Steam 상점 주소를 확인해주세요.');
  const targetThreadId = postIdFor(interaction.guildId, 'rec', game.key);
  if (!targetThreadId) {
    throw userError(`**${game.name}**에 연결된 녹화방 포스트가 없습니다. 먼저 해당 녹화방 포스트에서 \`/게임\`으로 게임을 연결해주세요.`);
  }

  const oldGame = {
    name: stream.game,
    key: stream.gameKey,
    appid: stream.appid ?? null,
    cooperative: stream.cooperative ?? null,
  };
  const oldPosted = stream.forumPosted ? {
    ...stream.forumPosted,
    messageIds: [...(stream.forumPosted.messageIds ?? [])],
  } : null;
  const moving = Boolean(oldPosted?.threadId && oldPosted.threadId !== targetThreadId);
  const ended = Boolean(stream.endedAt || session.closedAt);
  if (moving && !ended) {
    throw userError('진행 중인 방송에 이미 녹화방 게시물이 있어 지금은 옮길 수 없습니다. 방송을 종료한 뒤 다시 시도해주세요.');
  }
  await interaction.deferUpdate();
  setStreamGame(session, userId, game);

  let publishResult = null;
  if (ended) {
    if (moving) setStreamForumPosted(session, userId, null);
    publishResult = await publishStreamRecord(interaction.client, session, stream, { refreshPreview: true }).catch(() => null);
    if (!publishResult || !['posted', 'updated'].includes(publishResult.status)) {
      restoreStreamGame(session, userId, oldGame);
      setStreamForumPosted(session, userId, oldPosted);
      const failed = buildAdminRecordDetail(
        session,
        stream,
        '⚠️ 새 게임의 녹화방에 게시하지 못해 변경을 되돌렸습니다. 봇의 포스트 보기·메시지 전송 권한을 확인해주세요.'
      );
      return interaction.editReply({
        ...failed[failed.length - 1],
        allowedMentions: { parse: [] },
      });
    }
  }
  rememberGame(interaction.guildId, game, raw);

  const cleanupComplete = ended && moving
    ? await deleteOldRecordMessages(interaction.client, oldPosted)
    : true;
  const notice =
    `🎮 게임 연결을 **${game.name}**으로 수정했습니다.` +
    (ended && moving ? ' 녹화방 게시물도 새 게임으로 옮겼습니다.' : '') +
    (!cleanupComplete ? '\n⚠️ 새 게시물은 만들었지만 이전 녹화방 메시지 일부를 지우지 못했습니다. 이전 포스트를 확인해주세요.' : '');
  const pages = buildAdminRecordDetail(session, stream, notice);
  return interaction.editReply({
    ...pages[pages.length - 1],
    allowedMentions: { parse: [] },
  });
}

export function executeAdminRecords(interaction) {
  const filter = interaction.options.getString('범위') || 'attention';
  return interaction.reply({
    ...buildAdminRecordList(interaction.guildId, filter, 0),
    flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
  });
}

/** `/관리자 방송기록`에서 만든 목록·선택 구성요소를 처리합니다. */
export async function handleAdminRecordComponent(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: '서버 관리자만 방송 기록을 볼 수 있습니다.', flags: MessageFlags.Ephemeral });
  }
  const id = interaction.customId;
  if (id === 'tm:adminrecordfilter') {
    return interaction.update(buildAdminRecordList(interaction.guildId, interaction.values?.[0], 0));
  }
  if (id.startsWith('tm:adminrecords:')) {
    const [, , filter, page] = id.split(':');
    return interaction.update(buildAdminRecordList(interaction.guildId, filter, page));
  }
  if (id.startsWith('tm:adminrecordpick:')) {
    const [sessionId, userId] = String(interaction.values?.[0] ?? '').split(':');
    const session = sessionById(sessionId);
    const stream = session?.guildId === interaction.guildId ? streamOf(session, userId) : null;
    if (!stream) return interaction.reply({ content: '그 방송 기록을 찾지 못했습니다.', flags: MessageFlags.Ephemeral });
    const pages = buildAdminRecordDetail(session, stream);
    await interaction.reply({
      ...pages[0], flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
      allowedMentions: { parse: [] },
    });
    for (const payload of pages.slice(1)) {
      await interaction.followUp({
        ...payload, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
        allowedMentions: { parse: [] },
      });
    }
    return;
  }
  if (id.startsWith('tm:adminrecordgame:')) {
    const [, , sessionId, userId] = id.split(':');
    return openGameEditModal(interaction, sessionId, userId);
  }
}
