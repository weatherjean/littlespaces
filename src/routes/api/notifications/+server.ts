import {remoteNotifications,readRemoteNotifications} from '$lib/server/remote-notifications';
import {json} from '@sveltejs/kit';
import {listNotifications,markNotificationsRead} from '$lib/server/notifications';
import {body} from '$lib/server/security';
import type {RequestHandler} from './$types';
const notifications=async()=>[...listNotifications(),...await remoteNotifications()];
export const GET=async()=>json({notifications:await notifications()});
export const POST:RequestHandler=async event=>{
 const input=await body(event);
 if(input.action!=='read'||(input.id!==undefined&&typeof input.id!=='string'))return json({error:'Invalid notification action.'},{status:400});
 try{await readRemoteNotifications(input.id as string|undefined);markNotificationsRead(input.id as string|undefined);return json({notifications:await notifications()});}catch(error){return json({error:error instanceof Error?error.message:'Could not mark notifications read.'},{status:400});}
};
