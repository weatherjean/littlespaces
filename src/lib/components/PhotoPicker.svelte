<script lang="ts">
  import Icon from './Icon.svelte';
  import { uploadPhoto } from '$lib/photos';
  import type { Photo } from '$lib/photo-types';
  let { spaceId, onpicked, onbusy = () => {}, disabled = false }: {spaceId:string;onpicked:(photo:Photo)=>void;onbusy?:(busy:boolean)=>void;disabled?:boolean}=$props();
  let fileInput:HTMLInputElement, cameraInput:HTMLInputElement;
  let busy=$state(false),error=$state('');
  async function select(event:Event) {
    const input=event.currentTarget as HTMLInputElement;const file=input.files?.[0];input.value='';
    if(!file)return;
    busy=true;onbusy(true);error='';
    try {onpicked(await uploadPhoto(spaceId,file));}catch(e){error=e instanceof Error?e.message:'Could not upload photo.';}
    finally{busy=false;onbusy(false);}
  }
</script>
<div class="photo-picker-controls"><input class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" bind:this={fileInput} onchange={select} tabindex="-1" aria-label="Photo file" /><input class="visually-hidden" type="file" accept="image/*" capture="environment" bind:this={cameraInput} onchange={select} tabindex="-1" aria-label="Camera photo" />
<button class="secondary-button" type="button" disabled={disabled||busy} onclick={()=>fileInput.click()}><Icon name="image" size={17}/>{busy?'Saving photo…':'Choose photo'}</button><button class="secondary-button" type="button" disabled={disabled||busy} onclick={()=>cameraInput.click()}><Icon name="camera" size={17}/>Take photo</button></div>
{#if error}<p class="error" role="alert">{error}</p>{/if}
