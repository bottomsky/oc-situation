import { writeFile } from 'node:fs/promises';
import { createApi } from './app';
import type { Infrastructure } from '@ais/infrastructure';
// Generation constructs metadata without connecting to or querying any backend.
const api = await createApi({} as Infrastructure, { scheduler: false });
await writeFile(
  new URL('../openapi.json', import.meta.url),
  JSON.stringify(api.openapi, null, 2) + '\n',
);
await api.stop();
