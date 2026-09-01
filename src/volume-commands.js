// /음량 — 음악과 읽어주기의 소리 크기를 따로 맞춥니다.
//
// 왜 ffmpeg 으로 조절하는가:
//   discord.js 의 inlineVolume 을 쓰면 실시간으로 바꿀 수 있지만,
//   opus 를 PCM 으로 풀었다가 다시 인코딩해야 합니다.
//   이 프로젝트에는 순수 JS 인코더(opusscript)밖에 없어서 1코어 서버에서는 소리가 끊깁니다.
//   (ARCHITECTURE 3.2 절의 "재인코딩 회피" 가 통째로 깨집니다)
//
//   대신 ffmpeg 의 -af volume 을 씁니다. 그러면:
//     · 읽어주기 — 매 발화마다 새 ffmpeg 이 뜨므로 **바로** 반영됩니다.
//     · 음악     — 이미 흐르는 소리는 못 바꾸므로, 재생 중이면
//                  **듣던 지점부터 다시 틀어서** 반영합니다 (약 1초 끊깁니다).
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { volumePercent, setVolume, VOLUME_MAX } from './settings.js';
import { peekGuildAudio } from './audio/guild-audio.js';

/** 0~200 을 막대로. 한눈에 크기를 보여줍니다. */
function bar(percent) {
  const filled = Math.round((Math.min(percent, 100) / 100) * 10);
  const over = percent > 100 ? ` +${percent - 100}%` : '';
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + over;
}

function status(guildId) {
  const m = volumePercent(guildId, 'music');
  const t = volumePercent(guildId, 'tts');
  return [
    `🎵 음악      \`${bar(m)}\` **${m}%**`,
    `🗣️ 읽어주기  \`${bar(t)}\` **${t}%**`,
    '',
    '`/음량 음악:70` 처럼 바꿉니다. 100이 원음이고 200까지 올릴 수 있습니다.',
  ].join('\n');
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('음량')
      .setDescription('음악과 읽어주기의 소리 크기를 따로 맞춥니다 (비우면 현재 값만 봅니다)')
      .addIntegerOption((o) =>
        o.setName('음악').setDescription('0~200 (100이 원음)').setRequired(false).setMinValue(0).setMaxValue(VOLUME_MAX)
      )
      .addIntegerOption((o) =>
        o
          .setName('읽어주기')
          .setDescription('0~200 (100이 원음)')
          .setRequired(false)
          .setMinValue(0)
          .setMaxValue(VOLUME_MAX)
      ),
    async execute(interaction) {
      const music = interaction.options.getInteger('음악');
      const tts = interaction.options.getInteger('읽어주기');

      // 인자 없이 실행하면 지금 값만 보여줍니다.
      if (music === null && tts === null) {
        return interaction.reply({ content: status(interaction.guildId), flags: MessageFlags.Ephemeral });
      }

      const changed = [];
      if (music !== null) {
        setVolume(interaction.guildId, 'music', music);
        changed.push(`🎵 음악 **${music}%**`);
      }
      if (tts !== null) {
        setVolume(interaction.guildId, 'tts', tts);
        changed.push(`🗣️ 읽어주기 **${tts}%**`);
      }

      let note = '';
      if (music !== null) {
        // 재생 중이면 듣던 지점부터 다시 틀어 바로 반영합니다.
        const audio = peekGuildAudio(interaction.guildId);
        if (audio?.reapplyVolume()) note = '\n(재생 중이라 잠깐 끊겼다 이어집니다)';
      }
      if (tts !== null) note += '\n(읽어주기는 다음 문장부터 바로 적용됩니다)';

      await interaction.reply(`🔊 ${changed.join(' · ')} 로 맞췄습니다.${note}`);
    },
  },
];
