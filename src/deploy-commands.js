// 슬래시 명령어를 디스코드에 등록합니다.  실행: npm run deploy
//
// 서버(길드) 단위로 등록하므로 등록 즉시 반영됩니다.
// (전체 공개 등록은 반영에 최대 1시간이 걸려서 "봇이 고장났나?" 싶어집니다.)
//
// .env 의 GUILD_ID 에 쉼표로 여러 서버를 적으면 각각 등록합니다.
//   GUILD_ID=123456789012345678,987654321098765432
//
// 다시 실행해야 하는 때:
//   - 명령어를 추가/삭제/개명했을 때
//   - 봇을 새 서버에 초대했을 때 (그 서버 ID를 GUILD_ID 에 추가한 뒤)
import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { allCommands } from './commands.js';

const rest = new REST({ version: '10' }).setToken(config.token);
const body = allCommands.map((c) => c.data.toJSON());

// 봇을 나눠 돌리면 등록 대상이 둘입니다. 어느 쪽에 등록하는지 반드시 보여줍니다.
// (엉뚱한 쪽에 등록하면 상대 봇의 명령어가 통째로 지워집니다 — put 은 덮어쓰기입니다)
if (config.role !== 'all') {
  console.log(`역할: ${config.role} (${config.roleFeatures.join(', ')})`);
  console.log(`애플리케이션: ${config.clientId}\n`);
}

console.log(`명령어 ${body.length}개를 서버 ${config.guildIds.length}곳에 등록합니다...\n`);

let ok = 0;
const failures = [];

for (const guildId of config.guildIds) {
  try {
    const data = await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body });
    console.log(`  ✅ ${guildId} — ${data.length}개 등록됨`);
    ok++;
  } catch (err) {
    failures.push({ guildId, err });
    console.log(`  ❌ ${guildId} — ${reason(err)}`);
  }
}

function reason(err) {
  if (err.status === 401) return '토큰이 틀렸습니다 (DISCORD_TOKEN)';
  if (err.status === 403 || err.code === 50001) {
    return '이 서버에 접근할 수 없습니다 — 봇이 초대되지 않았거나 applications.commands 권한 없이 초대됨';
  }
  if (err.status === 404) return '서버를 찾을 수 없습니다 — GUILD_ID 가 틀렸거나 봇이 그 서버에 없습니다';
  return err.message;
}

console.log();

if (ok > 0) {
  console.log(`완료: ${ok}곳 성공${failures.length ? `, ${failures.length}곳 실패` : ''}`);
  console.log(allCommands.map((c) => `  /${c.data.name}`).join('\n'));
}

if (failures.length > 0) {
  // 서버 한 곳이 실패해도 나머지는 이미 등록됐습니다. 전체를 실패로 처리하지 않습니다.
  console.error('\n[실패한 서버 처리 방법]');
  for (const { guildId, err } of failures) {
    console.error(`  ${guildId}: ${reason(err)}`);
  }
  if (failures.some((f) => f.err.status === 401)) {
    console.error('  → .env 의 DISCORD_TOKEN 을 확인하세요.');
  } else {
    console.error('  → 봇을 그 서버에 초대했는지, GUILD_ID 를 올바르게 적었는지 확인하세요.');
    console.error('     (서버 아이콘 우클릭 → ID 복사. 개발자 모드가 켜져 있어야 보입니다)');
  }
}

// 전부 실패했을 때만 오류로 끝냅니다.
if (ok === 0) process.exit(1);
