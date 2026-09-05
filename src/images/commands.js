// 이미지 기능: 올라온 이미지 자동 저장 + 폴더 관리 슬래시 명령어
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import { config } from '../config.js';
import {
  saveAttachments,
  setChannelFolder,
  clearChannelFolder,
  resolveFolder,
  explainFolder,
  listFolders,
  isGalleryAttachment,
  baseDir,
} from './store.js';
import { imageChannelAllowed, featureEnabled } from '../settings.js';
import { showGalleryPanel } from './panel.js';
import { planCleanup, runCleanup, describe, maybeAutoCleanup, setNotifyChannel } from './cleanup.js';

/**
 * 감시 대상 채널에 올라온 이미지를 저장합니다.
 * @returns {boolean} 처리했으면 true
 */
export async function handleImageMessage(message) {
  // 기능을 끄면 새 사진만 저장하지 않습니다. 이미 모아둔 갤러리는 계속 볼 수 있습니다.
  if (!featureEnabled(message.guildId, 'images')) return false;

  // 스레드에 올라온 것도 부모 채널이 대상이면 받아줍니다.
  const parentId = message.channel?.isThread?.() ? message.channel.parentId : null;
  if (!imageChannelAllowed(message.guildId, message.channelId, parentId)) return false;

  if (message.attachments.size === 0) return false;
  if (![...message.attachments.values()].some(isGalleryAttachment)) return false;

  try {
    const { folder, saved } = await saveAttachments(message);
    if (saved.length === 0) return false;
    await message.react('✅').catch(() => {});
    console.log(`[images] ${saved.length}장 저장 → ${folder}`);
    // 갤러리 버튼을 채팅방 맨 아래로 올립니다. (매번 /갤러리 를 치지 않아도 되도록)
    showGalleryPanel(message.channel, folder);
    // 용량이 찼는지 확인합니다. 정리 결과는 이 채널에 알립니다.
    setNotifyChannel(message.channel);
    maybeAutoCleanup();
  } catch (err) {
    console.error('[images] 저장 실패:', err);
    await message.react('⚠️').catch(() => {});
  }
  return true;
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('갤러리수집')
      .setDescription('선택한 채널의 예전 사진과 동영상을 갤러리에 저장합니다')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption((o) => o.setName('채널').setDescription('과거 자료를 가져올 채널 또는 포럼').setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum,
          ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread)),
    async execute(interaction) {
      const channel = interaction.options.getChannel('채널', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (typeof channel.send === 'function') setNotifyChannel(channel);
        const result = await collectHistory(channel, async (progress) => {
          await interaction.editReply(`🖼️ 과거 자료를 수집하는 중… 메시지 ${progress.messages}개 확인 · 파일 ${progress.saved}개 저장`).catch(() => {});
          await maybeAutoCleanup();
        });
        if (result.saved > 0) {
          const folder = resolveFolder(channel, channel.id);
          if (channel.type !== ChannelType.GuildForum && channel.isTextBased?.()) showGalleryPanel(channel, folder);
        }
        await interaction.editReply([
          `✅ <#${channel.id}> 과거 자료 수집을 마쳤습니다.`,
          `메시지 **${result.messages}개** 확인 · 사진/동영상 **${result.saved}개** 저장`,
          result.failed ? `⚠️ 내려받지 못한 메시지 ${result.failed}개가 있습니다. 다시 실행하면 중복 없이 재시도합니다.` : '이미 저장된 첨부는 건너뛰었습니다.',
        ].join('\n'));
      } catch (err) {
        console.error('[images] 과거 자료 수집 실패:', err.message);
        await interaction.editReply(`⚠️ 과거 자료를 수집하지 못했습니다: ${err.message}\n봇의 **채널 보기 · 메시지 기록 보기** 권한을 확인한 뒤 다시 실행해주세요.`);
      }
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('폴더')
      .setDescription('이 채널의 사진이 어느 폴더에 저장되는지 보고, 바꿉니다')
      .addStringOption((o) =>
        o.setName('이름').setDescription('바꿀 폴더 이름 (비우면 현재 상태만 봅니다)').setRequired(false)
      )
      .addBooleanOption((o) =>
        o
          .setName('해제')
          .setDescription('직접 지정한 폴더를 없애고 채널 이름으로 되돌립니다')
          .setRequired(false)
      ),
    async execute(interaction) {
      const name = interaction.options.getString('이름');
      const reset = interaction.options.getBoolean('해제') ?? false;

      if (reset) {
        clearChannelFolder(interaction.channelId);
        return interaction.reply('📂 폴더 지정을 해제했습니다. 이제 채널 이름을 폴더로 씁니다.');
      }

      // 인자 없이 실행하면 지금 상태만 보여줍니다. (예전 /폴더확인 을 흡수)
      if (!name) {
        const now = resolveFolder(interaction.channel, interaction.channelId);
        const how = explainFolder(interaction.channel, interaction.channelId);
        return interaction.reply({
          content: [
            `현재 저장 폴더: **${now}**`,
            `(${how})`,
            `저장 위치: \`${baseDir()}\``,
            '',
            '바꾸려면 `/폴더 이름:<새이름>` · 되돌리려면 `/폴더 해제:true`',
          ].join('\n'),
          flags: MessageFlags.Ephemeral,
        });
      }

      const safe = setChannelFolder(interaction.channelId, name);
      await interaction.reply(`📂 이 채널의 이미지는 이제 **${safe}** 폴더에 저장됩니다.`);
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('폴더목록')
      .setDescription('저장된 폴더와 파일 수를 봅니다'),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const folders = await listFolders();
      if (folders.length === 0) {
        return interaction.editReply('아직 저장된 사진·동영상이 없습니다.');
      }
      const lines = folders
        .slice(0, 25)
        .map((f) => `• **${f.name}** — ${f.count}개`)
        .join('\n');
      const embed = new EmbedBuilder()
        .setTitle('📁 이미지 폴더')
        .setDescription(lines + (folders.length > 25 ? `\n… 외 ${folders.length - 25}개` : ''))
        .setFooter({ text: `전체 ${folders.reduce((a, f) => a + f.count, 0)}개` })
        .setColor(0x5865f2);
      await interaction.editReply({ embeds: [embed] });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('정리')
      // ★ **사진을 영구히 지우는** 명령어라 **관리자(서버 관리 권한)만** 쓸 수 있게 합니다.
      //   setDefaultMemberPermissions 는 디스코드가 직접 막아줍니다. 코드에서 검사하면
      //   새 명령어를 추가할 때 반드시 빠뜨립니다. 서버 주인이 필요하면
      //   서버 설정 → 연동 에서 명령어별로 다시 열어줄 수 있습니다.
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDescription('사진 용량을 보고, 오래된 것부터 정리합니다')
      .addBooleanOption((o) =>
        o
          .setName('지금바로')
          .setDescription('true 면 예산이 남아도 강제로 정리 대상을 계산합니다')
          .setRequired(false)
      ),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const force = interaction.options.getBoolean('지금바로') ?? false;
      const plan = await planCleanup({ force });

      if (!plan.need) {
        return interaction.editReply(describe(plan));
      }

      // ⚠️ 되돌릴 수 없으므로 **미리 보여주고 확인을 받습니다.** 바로 지우지 않습니다.
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('g:clean')
          .setLabel(`${plan.files.length}장 삭제`)
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('g:cancel').setLabel('취소').setStyle(ButtonStyle.Secondary)
      );
      await interaction.editReply({
        content: `${describe(plan)}\n\n**정말 지울까요? 되돌릴 수 없습니다.**`,
        components: [row],
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('갤러리')
      .setDescription('이 채널의 사진과 동영상을 골라 받을 수 있는 주소를 알려줍니다')
      .addStringOption((o) =>
        o.setName('폴더').setDescription('다른 폴더를 보려면 이름 입력 (비우면 이 채널)').setRequired(false)
      ),
    async execute(interaction) {
      // 기본은 **이 채널의 폴더**입니다.
      // 폴더 목록은 소유자 전용이라, 여기서 목록 링크를 주면 친구들이 막힌 페이지로 갑니다.
      const folder =
        interaction.options.getString('폴더') ??
        resolveFolder(interaction.channel, interaction.channelId);
      const url = `${config.images.webPublicUrl}/f/${encodeURIComponent(folder)}`;

      // 보기·내려받기는 암호가 없습니다. 링크만 있으면 친구들도 바로 열 수 있습니다.
      await interaction.reply({
        content: [
          `🖼️ **${folder}** 폴더`,
          url,
          '사진을 클릭해 여러 개 고르고 **⬇️ 선택한 파일 받기** 를 누르면 하나씩 전부 저장됩니다.',
          '(Shift+클릭 으로 범위 선택, **전체 선택** 버튼도 있습니다)',
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];

/** 선택한 채널 또는 포럼의 모든 과거 메시지를 오래된 자료까지 거슬러 수집합니다. */
export async function collectHistory(channel, onProgress = async () => {}) {
  const targets = [];
  if (channel.type === ChannelType.GuildForum) {
    const active = await channel.threads.fetchActive();
    targets.push(...[...active.threads.values()].filter((thread) => thread.parentId === channel.id));
    let before;
    do {
      const page = await channel.threads.fetchArchived({ limit: 100, ...(before ? { before } : {}) });
      targets.push(...[...page.threads.values()].filter((thread) => thread.parentId === channel.id));
      before = page.hasMore ? page.threads.last()?.archivedAt : null;
    } while (before);
  } else {
    targets.push(channel);
  }

  let messages = 0;
  let saved = 0;
  let failed = 0;
  const seenTargets = new Set();
  for (const target of targets) {
    if (seenTargets.has(target.id) || !target.messages?.fetch) continue;
    seenTargets.add(target.id);
    let before;
    while (true) {
      const page = await target.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (page.size === 0) break;
      for (const message of page.values()) {
        messages++;
        if (![...message.attachments.values()].some(isGalleryAttachment)) continue;
        try { saved += (await saveAttachments(message)).saved.length; }
        catch (err) { failed++; console.warn('[images] 과거 첨부 저장 실패:', message.id, err.message); }
      }
      before = page.last()?.id;
      await onProgress({ messages, saved, failed });
      if (page.size < 100 || !before) break;
    }
  }
  return { messages, saved, failed };
}

/** /정리 의 확인 버튼. customId 가 `g:` 으로 시작하는 것만 옵니다. */
export async function handleImageComponent(interaction) {
  if (interaction.customId === 'g:cancel') {
    return interaction.update({ content: '취소했습니다. 아무것도 지우지 않았습니다.', components: [] });
  }
  if (interaction.customId !== 'g:clean') return;

  await interaction.update({ content: '🧹 정리하는 중…', components: [] });

  // 버튼을 누른 시점에 다시 계산합니다.
  // 미리보기 이후 사진이 더 올라왔을 수 있는데, 옛 목록으로 지우면 엉뚱한 파일을 건드립니다.
  const plan = await planCleanup({ force: true });
  if (!plan.need) {
    return interaction.editReply({ content: '정리할 것이 없습니다.', components: [] });
  }
  const deleted = await runCleanup(plan);
  await interaction.editReply({
    content: `🧹 **${deleted}장**을 지워 ${(plan.freed / 1024 ** 2).toFixed(0)}MB 를 확보했습니다.`,
    components: [],
  });
}
