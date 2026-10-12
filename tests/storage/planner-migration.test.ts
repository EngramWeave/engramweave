import {expect,it} from 'vitest';
import {analyzerFixture} from '../helpers/analyzer.js';
import {openDatabase} from '../../packages/core/src/storage/database.js';
it('migrates shipped v5 while preserving processing records and rejecting malformed layouts',async()=>{
  const f=await analyzerFixture();let db=f.db;
  try{
    db.exec('DROP TABLE planner_jobs');db.prepare('UPDATE meta SET schema_version=5,index_generation=31').run();db.pragma('user_version=5');
    db.prepare('INSERT INTO processing_rounds VALUES(?,?,?)').run('round','{}','{"status":"succeeded"}');db.close();db=await openDatabase(f.config);
    expect(db.pragma('user_version',{simple:true})).toBe(6);expect(db.prepare('SELECT round_json FROM processing_rounds').get()).toEqual({round_json:'{"status":"succeeded"}'});
    expect(db.prepare('SELECT index_generation FROM meta').get()).toEqual({index_generation:31});db.exec('DROP INDEX one_active_planner');db.close();await expect(openDatabase(f.config)).rejects.toMatchObject({code:'SCHEMA_UNSUPPORTED'});
  }finally{await f.analyzer.close();if(db.open)db.close();await f.cleanup();}
});
