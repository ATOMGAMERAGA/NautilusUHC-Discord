import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/voicecore.js';

const snapshot = () => ({enabled:true,active:true,matchKey:'live:7',teams:[{number:1},{number:2}],links:[
  {uuid:'one',discordId:'a',online:true,participant:true,alive:true,team:1},
]});

test('voice snapshot rejects partial or contradictory match data before routing or cleanup', () => {
  assert.equal(typeof core.isValidVoiceSnapshot, 'function');
  const invalid = [null, [], {}, {...snapshot(),enabled:false}, {...snapshot(),matchKey:''},
    {...snapshot(),active:false,matchKey:undefined},
    {...snapshot(),links:[{...snapshot().links[0],online:undefined}]},
    {...snapshot(),enabled:'true'}, {...snapshot(),active:1}, {...snapshot(),teams:null},
    {...snapshot(),teams:[null]}, {...snapshot(),teams:[{number:'1'}]},
    {...snapshot(),teams:[{number:1},{number:1}]}, {...snapshot(),links:[null]},
    {...snapshot(),links:[{}]}, {...snapshot(),links:[{...snapshot().links[0],discordId:''}]},
    {...snapshot(),links:[{...snapshot().links[0],participant:undefined}]},
    {...snapshot(),links:[{...snapshot().links[0],alive:undefined}]},
    {...snapshot(),links:[{...snapshot().links[0],online:'false'}]},
    {...snapshot(),links:[{...snapshot().links[0],team:'1'}]},
    {...snapshot(),links:[{...snapshot().links[0],team:3}]},
    {...snapshot(),links:[snapshot().links[0],{...snapshot().links[0],team:2}]},
  ];
  for (const state of invalid) assert.equal(core.isValidVoiceSnapshot(state),false,JSON.stringify(state));
});

test('voice snapshot accepts complete live, solo, planned, idle and legacy account records', () => {
  assert.equal(typeof core.isValidVoiceSnapshot, 'function');
  const valid = [snapshot(), {...snapshot(),links:[]}, {...snapshot(),teams:[],links:[{discordId:'a',participant:true,alive:true}]},
    {...snapshot(),links:[{discordId:'a',participant:true,alive:true,team:null}]},
    {enabled:true,active:false,matchKey:'',teams:[{number:1}],links:[{discordId:'a'}]},
    {enabled:false,active:false,matchKey:'',teams:[],links:[]},
    {...snapshot(),links:[...snapshot().links,{uuid:'two',discordId:'a',online:false,participant:true,alive:true,team:2}]},
  ];
  for (const state of valid) assert.equal(core.isValidVoiceSnapshot(state),true,JSON.stringify(state));
});

test('two-account routing prefers online participant over online nonparticipant independently of UUID order', () => {
  const first={uuid:'a',discordId:'d',online:true,participant:false,alive:true,team:1};
  const second={uuid:'z',discordId:'d',online:true,participant:true,alive:true,team:2};
  assert.equal(core.destination({active:true},core.selectVoiceLink([first,second],'d')),'team:2');
  assert.equal(core.destination({active:true},core.selectVoiceLink([{...second,online:false},first],'d')),'global');
  assert.equal(core.destination({active:true},core.selectVoiceLink([{...first,online:false},{...second,online:false}],'d')),'global');
});
