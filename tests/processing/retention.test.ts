import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { LIMITS } from '@engramweave/contracts';
import { analyzerFixture, emptyAnalysis } from '../helpers/analyzer.js';
import { AnalyzerJobs } from '../../packages/core/src/jobs/analyzer.js';
import { retainFinishedJobs } from '../../packages/core/src/jobs/retention.js';

it('bounds terminal failure history while protecting earlier successful task results and retained round dependencies', async () => {
  const f=await analyzerFixture(async task=>emptyAnalysis(task));
  try {
    const initial=f.request();await f.analyzer.submit(initial);await f.analyzer.wait();const original=await f.analyzer.results.read(initial.request_id);const ids:string[]=[];
    for(let i=0;i<LIMITS.retained_finished_jobs+7;i++) {
      const record=structuredClone(original),id=randomUUID();ids.push(id);record.job.id=id;record.request.request_id=id;record.job.status='failed';record.job.created_at=new Date(Date.parse(original.job.created_at)+i+1).toISOString();
      for(const task of ['review','relation'] as const){record.job[task].status='failed';record.job[task].error={code:'INVALID_MODEL_OUTPUT',message:'Fixture failure',details:null};record.job[task].attempts=[];record[task].result=null;}
      await f.analyzer.results.save(record);
    }
    const round={id:randomUUID(),status:'failed',created_at:new Date().toISOString(),items:[{analyzer_job_id:ids[0]}]};f.db.prepare('INSERT INTO processing_rounds VALUES(?,?,?)').run(round.id,'{}',JSON.stringify(round));
    let calls=0;const recovered=new AnalyzerJobs(f.db,f.config,f.recall,()=>false,async task=>{calls++;return emptyAnalysis(task);});await recovered.initialize();
    expect(calls).toBe(0);expect(recovered.get(initial.request_id)).toBeDefined();expect(recovered.get(ids[0]!)).toBeDefined();expect(recovered.get(ids[1]!)).toBeUndefined();expect(recovered.all().length).toBeLessThanOrEqual(LIMITS.retained_finished_jobs+3);expect((await recovered.result(initial.request_id)).review).not.toBeNull();await recovered.close();
  }finally{await f.close();}
});
it('retains the local registration Job linked by an inspectable round',async()=>{
  const f=await analyzerFixture();
  try {
    for(let i=0;i<LIMITS.retained_finished_jobs+3;i++)f.db.prepare("INSERT INTO jobs(id,kind,mode,status,created_at,finished_at) VALUES(?,'scan_vault','refresh','succeeded',?,?)").run(`scan-${i}`,new Date(1000+i).toISOString(),new Date(1000+i).toISOString());
    const round={id:randomUUID(),items:[],registration_job_id:'scan-0'};f.db.prepare('INSERT INTO processing_rounds VALUES(?,?,?)').run(round.id,'{}',JSON.stringify(round));retainFinishedJobs(f.db);
    expect(f.db.prepare("SELECT id FROM jobs WHERE id='scan-0'").get()).toBeDefined();expect(f.db.prepare("SELECT id FROM jobs WHERE id='scan-1'").get()).toBeUndefined();expect((f.db.prepare('SELECT count(*) AS count FROM jobs').get() as {count:number}).count).toBe(LIMITS.retained_finished_jobs+1);
  }finally{await f.close();}
});
