// 관리자 전용 명령을 `/관리자 <세부명령어>` 하나로 모읍니다.
//
// 실제 동작은 기존 모듈의 execute/autocomplete를 그대로 재사용합니다. 설정 화면의 로직을
// 여기에도 복사하면 두 경로가 금방 달라지기 때문입니다. deploy 시 예전 최상위 명령은 사라집니다.
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { commands as featureCommands } from './feature-commands.js';
import { commands as channelCommands, channelChoices } from './channel-commands.js';
import { commands as imageCommands } from './images/commands.js';
import { commands as symbolCommands } from './symbol-commands.js';
import { commands as voiceProbeCommands } from './stream/voice-probe.js';
import { inRole } from './settings.js';

const byName = (commands, name) => commands.find((command) => command.data.toJSON().name === name);

const actions = new Map([
  ['기능', byName(featureCommands, '기능')],
  ['채널설정', byName(channelCommands, '채널설정')],
]);

if (inRole('images')) {
  actions.set('갤러리수집', byName(imageCommands, '갤러리수집'));
  actions.set('정리', byName(imageCommands, '정리'));
}
if (inRole('stream')) actions.set('상징이모지', byName(symbolCommands, '상징이모지'));
// 소리 녹음(30초 되돌리기)을 만들기 전에 **수신이 되는지부터** 확인하는 진단입니다.
// 커넥션은 양쪽 봇에 다 있지만, 이 진단이 필요한 기능은 방송 기록이므로 그쪽에만 둡니다.
// (노래하는 망고의 `/관리자` 를 진단으로 늘리지 않습니다)
if (inRole('stream')) actions.set('음성수신확인', byName(voiceProbeCommands, '음성수신확인'));

const data = new SlashCommandBuilder()
  .setName('관리자')
  .setDescription('망고의 서버 설정과 관리 기능을 사용합니다')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) => sub.setName('기능').setDescription('기능을 켜고 끕니다'))
  .addSubcommand((sub) => sub.setName('채널설정').setDescription('기능별 채널을 보고 지정합니다')
    .addStringOption((option) => option.setName('종류').setDescription('무엇을 지정할지').addChoices(...channelChoices))
    .addChannelOption((option) => option.setName('채널').setDescription('지정할 채널 (비우면 현재 채널)')
      .addChannelTypes(
        ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice,
        ChannelType.GuildStageVoice, ChannelType.GuildCategory, ChannelType.GuildForum, ChannelType.GuildMedia
      )));

if (actions.has('갤러리수집')) {
  data.addSubcommand((sub) => sub.setName('갤러리수집').setDescription('현재 또는 선택한 채널의 예전 사진과 동영상을 저장합니다')
    .addChannelOption((option) => option.setName('채널').setDescription('과거 자료를 가져올 채널 또는 포럼 (비우면 현재 채널)')
      .addChannelTypes(
        ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum,
        ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread
      )));
  data.addSubcommand((sub) => sub.setName('정리').setDescription('사진 용량을 보고 오래된 것부터 정리합니다')
    .addBooleanOption((option) => option.setName('지금바로').setDescription('예산이 남아도 강제로 정리 대상을 계산합니다')));
}
if (actions.has('음성수신확인')) {
  data.addSubcommand((sub) => sub.setName('음성수신확인').setDescription('망고가 음성채널 소리를 받을 수 있는지 확인합니다 (저장하지 않습니다)')
    .addIntegerOption((option) => option.setName('초').setDescription('몇 초 동안 확인할지 (기본 15초, 최대 30초)').setMinValue(5).setMaxValue(30)));
}
if (actions.has('상징이모지')) {
  data.addSubcommand((sub) => sub.setName('상징이모지').setDescription('사람 이름 앞에 붙일 서버 이모지를 정합니다')
    .addUserOption((option) => option.setName('사람').setDescription('상징 이모지를 지정할 사람').setRequired(true))
    .addIntegerOption((option) => option.setName('목록페이지').setDescription('이름을 모를 때 25개씩 넘겨보기').setMinValue(1).setMaxValue(100))
    .addStringOption((option) => option.setName('이모지').setDescription('이름으로 서버 전체 검색 (비우면 해제)').setAutocomplete(true)));
}

export const commands = [{
  data,
  async autocomplete(interaction) {
    const action = actions.get(interaction.options.getSubcommand());
    if (action?.autocomplete) await action.autocomplete(interaction);
    else await interaction.respond([]);
  },
  async execute(interaction) {
    const name = interaction.options.getSubcommand();
    const action = actions.get(name);
    if (!action) {
      return interaction.reply({ content: '이 봇에서 사용할 수 없는 관리자 기능입니다.', flags: MessageFlags.Ephemeral });
    }
    return action.execute(interaction);
  },
}];
