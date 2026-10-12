import {expect,it} from 'vitest';
import {analyzerFixture} from '../helpers/analyzer.js';
import {openDatabase} from '../../packages/core/src/storage/database.js';
it('migrates shipped v5 while preserving processing records and rejecting malformed layouts',async()=>{
  const f=await analyzerFixture();let db=f.db;
  try{
    db.exec('DROP TABLE integration_jobs; DROP TABLE planner_jobs');db.prepare('UPDATE meta SET schema_version=5,index_generation=31').run();db.pragma('user_version=5');
    db.prepare('INSERT INTO processing_rounds VALUES(?,?,?)').run('round','{}','{"status":"succeeded"}');db.close();db=await openDatabase(f.config);
    expect(db.pragma('user_version',{simple:true})).toBe(7);expect(db.prepare('SELECT round_json FROM processing_rounds').get()).toEqual({round_json:'{"status":"succeeded"}'});
    expect(db.prepare('SELECT index_generation FROM meta').get()).toEqual({index_generation:31});db.exec('DROP INDEX one_active_planner');db.close();await expect(openDatabase(f.config)).rejects.toMatchObject({code:'SCHEMA_UNSUPPORTED'});
  }finally{await f.analyzer.close();if(db.open)db.close();await f.cleanup();}
});
it('migrates shipped v6 preserving Planner jobs and generation while adding the rebuildable execution projection',async()=>{
  const f=await analyzerFixture();let db=f.db;
  try{
    db.exec('DROP TABLE integration_jobs');db.prepare('UPDATE meta SET schema_version=6,index_generation=77').run();db.pragma('user_version=6');
    db.prepare('INSERT INTO planner_jobs VALUES(?,?,?)').run('planned','{"status":"succeeded"}','{}');db.close();db=await openDatabase(f.config);
    expect(db.pragma('user_version',{simple:true})).toBe(7);expect(db.prepare('SELECT job_json FROM planner_jobs').get()).toEqual({job_json:'{"status":"succeeded"}'});
    expect(db.prepare('SELECT index_generation FROM meta').get()).toEqual({index_generation:77});expect(db.prepare('SELECT count(*) AS total FROM integration_jobs').get()).toEqual({total:0});
    db.exec('ALTER TABLE integration_jobs ADD COLUMN unexpected TEXT');db.close();await expect(openDatabase(f.config)).rejects.toMatchObject({code:'SCHEMA_UNSUPPORTED'});
  }finally{await f.analyzer.close();if(db.open)db.close();await f.cleanup();}
});
