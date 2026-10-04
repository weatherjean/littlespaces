import {json} from '@sveltejs/kit';
import {listNotifications,markNotificationsRead} from '$lib/server/notifications';
import {body} from '$lib/server/security';
import type {RequestHandler} from './$types';
export const GET=()=>json({notifications:listNotifications()});
export const POST:RequestHandler=async event=>{
 const input=await body(event);
 if(input.action!=='read'||(input.id!==undefined&&typeof input.id!=='string'))return json({error:'Invalid notification action.'},{status:400});
 markNotificationsRead(input.id as string|undefined);return json({notifications:listNotifications()});
};
