import { loadBuiltinSkillCatalog } from './builtins';

const catalog = await loadBuiltinSkillCatalog();
for (const metadata of catalog.list()) {
  const skill = catalog.get(metadata.skillId);
  console.log(`${metadata.skillId}@${metadata.version} ${skill.binding.contentHash}`);
}
if (catalog.list().length !== 5) throw new Error('Expected five bundled skills');
