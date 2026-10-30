type LockEntry=[string,string,{dependencies?:Record<string,string>;optionalDependencies?:Record<string,string>},...unknown[]];
type Lock={workspaces:Record<string,{dependencies?:Record<string,string>}>;packages:Record<string,LockEntry>};

/** Conservative runtime closure; build tools and optional database-driver peers
 * are not executable dependencies of this D1/React application. */
export function runtimeNodes(lock:Lock) {
  const resolve=(from:string,name:string)=>{
    for(let parent=from;parent;parent=parent.slice(0,Math.max(0,parent.lastIndexOf('/')))) {
      const nested=parent+'/'+name;if(lock.packages[nested])return nested;
    }
    return lock.packages[name]?name:undefined;
  };
  const visited=new Set<string>();
  const visit=(key:string)=>{
    if(visited.has(key))return;visited.add(key);
    const metadata=lock.packages[key]?.[2];
    for(const name of Object.keys({...metadata?.dependencies,...metadata?.optionalDependencies})) {
      const child=resolve(key,name);if(child)visit(child);
    }
  };
  for(const workspace of ['server','client'])for(const name of Object.keys(lock.workspaces[workspace]?.dependencies||{})) {
    const root=resolve(workspace,name);if(!root)throw Error(`Missing installed runtime dependency: ${name}`);visit(root);
  }
  return [...visited].map(key=>{
    const match=lock.packages[key][0].match(/^(.+)@([^@]+)$/);
    return {key,name:match?.[1] || key,version:match?.[2] || ''};
  });
}

if(import.meta.main) {
  const lock=Bun.JSONC.parse(await Bun.file('bun.lock').text()) as Lock;
  const result=Bun.spawnSync(['bun','audit','--json'],{stdout:'pipe',stderr:'pipe'});
  let advisories:Record<string,Array<{url:string;severity:string;vulnerable_versions:string}>>;
  try{advisories=JSON.parse(new TextDecoder().decode(result.stdout));}
  catch{throw Error('Dependency audit unavailable; release stopped rather than reporting a clean scan');}
  const nodes=runtimeNodes(lock),affected=nodes.flatMap(node=>(advisories[node.name]||[])
    .filter(advisory=>Bun.semver.satisfies(node.version,advisory.vulnerable_versions))
    .map(advisory=>({package:node.name,version:node.version,severity:advisory.severity,url:advisory.url})));
  const report={runtimeNodes:nodes.length,runtimeAffected:affected,remainingToolingPackages:Object.keys(advisories).filter(name=>!affected.some(row=>row.package===name))};
  console.log(JSON.stringify(report,null,2));
  if(affected.length)process.exitCode=1;
}
