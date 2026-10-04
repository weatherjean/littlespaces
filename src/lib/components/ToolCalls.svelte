<script lang="ts">
 import type {ToolCall} from '$lib/types';
 let {calls}:{calls:ToolCall[]}=$props();
 function format(value:unknown){if(typeof value==='string'){try{return JSON.stringify(JSON.parse(value),null,2);}catch{return value;}}return JSON.stringify(value,null,2);}
</script>
<div class="tool-calls" aria-label="Tool activity">
 {#each calls as call (call.id)}<details class="tool-call" class:tool-error={call.status==='error'}>
 <summary><span class="tool-mark">↳</span><strong>{call.name}</strong><span>{call.status}{call.durationMs!==undefined?` · ${call.durationMs} ms`:''}</span></summary>
 <div class="tool-details">{#if call.prompt}<p class="muted">For: {call.prompt}</p>{/if}<h4>Input</h4><pre>{format(call.input)}</pre>{#if call.output!==undefined}<h4>Result</h4><pre>{format(call.output)}</pre>{/if}<small>{new Date(call.startedAt).toLocaleString()}</small></div>
 </details>{/each}
</div>
