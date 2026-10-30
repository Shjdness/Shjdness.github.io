type LockEntry=[string,string,{dependencies?:Record<string,string>;optionalDependencies?:Record<string,string>},...unknown[]];
type Lock={workspaces:Record<string,{dependencies?:Record<string,string>}>;packages:Record<string,LockEntry>};
type Advisory={url:string;severity:string;vulnerable_versions:string};

export function parseAudit(stdout:string,exitCode:number):Record<string,Advisory[]> {
  const unavailable=()=>new Error('Dependency audit unavailable; release stopped rather than reporting a clean scan');
  if(exitCode!==0 && exitCode!==1)throw unavailable();
  let value:unknown;
  try{value=JSON.parse(stdout);}catch{throw unavailable();}
  if(!value || typeof value!=='object' || Array.isArray(value))throw unavailable();
  const entries=Object.entries(value);
  if(exitCode===1 && !entries.length)throw unavailable();
  for(const [,rows] of entries) {
    if(!Array.isArray(rows)||!rows.length)throw unavailable();
    for(const row of rows)if(!row || typeof row!=='object' ||
      typeof row.url!=='string' || !row.url.startsWith('https://') ||
      !['low','moderate','high','critical'].includes(row.severity) ||
      typeof row.vulnerable_versions!=='string' || !row.vulnerable_versions.trim())throw unavailable();
  }
  return value as Record<string,Advisory[]>;
}

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
  const advisories=parseAudit(new TextDecoder().decode(result.stdout),result.exitCode);
  const nodes=runtimeNodes(lock),affected=nodes.flatMap(node=>(advisories[node.name]||[])
    .filter(advisory=>Bun.semver.satisfies(node.version,advisory.vulnerable_versions))
    .map(advisory=>({package:node.name,version:node.version,severity:advisory.severity,url:advisory.url})));
  const report={runtimeNodes:nodes.length,runtimeAffected:affected,remainingToolingPackages:Object.keys(advisories).filter(name=>!affected.some(row=>row.package===name))};
  console.log(JSON.stringify(report,null,2));
  if(affected.length)process.exitCode=1;
}
