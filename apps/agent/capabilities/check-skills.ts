import { loadBuiltinSkillCatalog, BUILTIN_SKILL_BINDINGS } from './builtins';

const catalog = await loadBuiltinSkillCatalog();
for (const metadata of catalog.list()) {
  const skill = catalog.get(metadata.skillId);
  console.log(`${metadata.skillId}@${metadata.version} ${skill.binding.contentHash}`);
}
if (catalog.list().length !== BUILTIN_SKILL_BINDINGS.length)
  throw new Error('Bundled skill catalog is incomplete');
