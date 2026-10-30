import {it,expect} from 'vitest';
import {runtimeNodes} from './audit-runtime';
it('follows nested runtime versions while excluding development-only roots',()=>{
  const nodes=runtimeNodes({workspaces:{server:{dependencies:{api:'1'}},client:{dependencies:{ui:'1'}}},packages:{
    api:['api@1.0.0','',{dependencies:{shared:'1'}}],
    ui:['ui@1.0.0','',{dependencies:{shared:'2'}}],
    'api/shared':['shared@1.0.0','',{}],shared:['shared@2.0.0','',{}],tool:['tool@1.0.0','',{dependencies:{unused:'1'}}],unused:['unused@1.0.0','',{}]
  }});
  expect(nodes.map(node=>node.key).sort()).toEqual(['api','api/shared','shared','ui']);
  expect(nodes.find(node=>node.key==='api/shared')?.version).toBe('1.0.0');
});
it('stops when a declared runtime dependency is missing from the lockfile',()=>{
  expect(()=>runtimeNodes({workspaces:{server:{dependencies:{missing:'1'}}},packages:{}})).toThrow('Missing installed runtime dependency');
});
