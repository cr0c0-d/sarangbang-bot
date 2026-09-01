// /음량 — 음악 소리 크기를 맞춥니다. **노래하는 망고 전용입니다.**
//
// 원래는 음악과 읽어주기를 따로 맞추는 명령어였습니다. 봇을 완전히 나누면서
// 읽어주기 쪽 음량 조절은 걷어냈고(소유자 요청), 여기는 음악만 남았습니다.
//
// 왜 ffmpeg 으로 조절하는가:
//   discord.js 의 inlineVolume 을 쓰면 실시간으로 바꿀 수 있지만,
//   opus 를 PCM 으로 풀었다가 다시 인코딩해야 합니다.
//   이 프로젝트에는 순수 JS 인코더(opusscript)밖에 없어서 1코어 서버에서는 소리가 끊깁니다.
//   (ARCHITECTURE 3.2 절의 "재인코딩 회피" 가 통째로 깨집니다)
//
//   대신 ffmpeg 의 -af volume 을 씁니다. 이미 흐르는 소리는 못 바꾸므로 다시 틀어야 하는데,
//   **새 소리를 다 준비한 뒤에 바꿔치기**하므로 끊기지 않습니다 (3.2-1 절).
//   대신 누른 뒤 1~2초쯤 지나 바뀝니다.
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { volumePercent, setVolume, VOLUME_MAX } from '../settings.js';
import { peekGuildAudio } from '../audio/guild-audio.js';

/** 0~200 을 막대로. 한눈에 크기를 보여줍니다. */
function bar(percent) {
  const filled = Math.round((Math.min(percent, 100) / 100) * 10);
  const over = percent > 100 ? ` +${percent - 100}%` : '';
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + over;
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('음량')
      .setDescription('음악 소리 크기를 맞춥니다 (비우면 지금 값만 봅니다)')
      .addIntegerOption((o) =>
        o.setName('크기').setDescription('0~200 (100이 원음)').setRequired(false).setMinValue(0).setMaxValue(VOLUME_MAX)
      ),
    async execute(interaction) {
      const want = interaction.options.getInteger('크기');

      // 인자 없이 실행하면 지금 값만 보여줍니다. (상태 보는 명령어를 따로 만들지 않습니다)
      if (want === null) {
        const now = volumePercent(interaction.guildId, 'music');
        return interaction.reply({
          content: `🔊 음악 음량 \`${bar(now)}\` **${now}%**\n\n\`/음량 크기:70\` 처럼 바꿉니다. 100이 원음이고 200까지 올릴 수 있습니다.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const now = setVolume(interaction.guildId, 'music', want);

      // 재생 중이면 듣던 지점부터 다시 틉니다.
      // 새 소리를 준비한 뒤 바꿔치기하므로 끊기지 않습니다.
      const audio = peekGuildAudio(interaction.guildId);
      const note = audio?.reapplyVolume() ? '\n(듣던 곳에서 곧 바뀝니다. 끊기지 않습니다)' : '';

      await interaction.reply(`🔊 음악 음량을 **${now}%** 로 맞췄습니다.${note}`);
    },
  },
];
