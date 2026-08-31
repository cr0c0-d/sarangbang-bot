// 슬래시 명령어를 디스코드에 등록합니다.  실행: npm run deploy
//
// 서버(길드) 단위로 등록하므로 등록 즉시 반영됩니다.
// (전체 공개 등록은 반영에 최대 1시간이 걸려서 "봇이 고장났나?" 싶어집니다.)
// 명령어를 추가하거나 설명을 바꿨을 때만 다시 실행하면 됩니다.
import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { allCommands } from './commands.js';

const rest = new REST({ version: '10' }).setToken(config.token);
const body = allCommands.map((c) => c.data.toJSON());

try {
  console.log(`${body.length}개 명령어를 등록합니다...`);
  const data = await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
  console.log(`✅ 완료: ${data.length}개`);
  console.log(data.map((c) => `  /${c.name}`).join('\n'));
} catch (err) {
  console.error('❌ 등록 실패:', err.message);
  if (err.status === 401) {
    console.error('   → DISCORD_TOKEN 이 틀렸습니다.');
  } else if (err.status === 403 || err.code === 50001) {
    console.error(
      '   → 봇이 해당 서버에 없거나 applications.commands 권한 없이 초대되었습니다.\n' +
        '     README의 초대 링크로 다시 초대해주세요.'
    );
  } else if (err.status === 404) {
    console.error('   → CLIENT_ID 또는 GUILD_ID 가 틀렸습니다.');
  }
  process.exit(1);
}
