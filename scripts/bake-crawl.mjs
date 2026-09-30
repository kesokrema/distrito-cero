import { build } from 'esbuild';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
const temporary = await mkdtemp(join(tmpdir(), 'distrito-crawl-'));
try {
  const entry = join(temporary, 'joint-animation.mjs');
  await build({entryPoints:['src/actors/JointAnimation.ts'],bundle:true,platform:'node',format:'esm',outfile:entry,logLevel:'silent'});
  const { bakeCrawlMotion } = await import(pathToFileURL(entry).href);
  const data = await readFile('public/animations/mixamo/crawl.fbx');
  const rig = new FBXLoader().parse(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),'');
  const motion = bakeCrawlMotion(rig,rig.animations[0]);
  await writeFile('public/animations/mixamo/crawl-motion.json',JSON.stringify(motion));
  console.log(`Converted Crawling.fbx: ${motion.frames.length} frames, ${motion.duration.toFixed(2)} seconds.`);
} finally { await rm(temporary,{recursive:true,force:true}); }
