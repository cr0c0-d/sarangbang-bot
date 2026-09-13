// 관리자용 방송 기록 조회.
//
// 기록은 180일 보존되는 streams.json을 그대로 읽습니다. 별도 복사본을 만들면 실제 타임라인과
// 관리자 목록의 상태가 어긋나므로, 화면을 열거나 넘길 때마다 현재 저장소에서 다시 계산합니다.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} from 'discord.js';
import { sessionsForGuild, sessionById, streamOf, timelineFor } from './store.js';
import { postIdFor } from '../game/store.js';
import { symbolMention } from '../settings.js';
import { buildSummary } from './panel.js';

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
    const pages = buildSummary(session, stream);
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
}
