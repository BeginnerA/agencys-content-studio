// 一次性：把生成的基线迁移改写为幂等（IF NOT EXISTS），兼容已存在表/索引的存量库。验证后删除。
const fs = require('node:fs');
const file = process.argv[2];
if (!file) { console.error('need sql file path'); process.exit(2); }
let t = fs.readFileSync(file, 'utf8');
const before = {
  table: (t.match(/CREATE TABLE /g) || []).length,
  index: (t.match(/CREATE INDEX /g) || []).length,
  uniq: (t.match(/CREATE UNIQUE INDEX /g) || []).length,
};
t = t.replace(/CREATE TABLE `/g, 'CREATE TABLE IF NOT EXISTS `');
t = t.replace(/CREATE UNIQUE INDEX `/g, 'CREATE UNIQUE INDEX IF NOT EXISTS `');
t = t.replace(/CREATE INDEX `/g, 'CREATE INDEX IF NOT EXISTS `');
fs.writeFileSync(file, t, 'utf8');
const after = {
  plainTable: (t.match(/CREATE TABLE (?!IF NOT EXISTS)/g) || []).length,
  plainIndex: (t.match(/CREATE INDEX (?!IF NOT EXISTS)/g) || []).length,
  plainUniq: (t.match(/CREATE UNIQUE INDEX (?!IF NOT EXISTS)/g) || []).length,
  idemTable: (t.match(/CREATE TABLE IF NOT EXISTS/g) || []).length,
  idemIndex: (t.match(/CREATE INDEX IF NOT EXISTS/g) || []).length,
  idemUniq: (t.match(/CREATE UNIQUE INDEX IF NOT EXISTS/g) || []).length,
};
console.log('BEFORE', JSON.stringify(before));
console.log('AFTER ', JSON.stringify(after));
