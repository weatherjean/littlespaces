// Existing icon names remain compatible; the launcher gives them a friendly face.
export function appEmoji(name:string,icon='grid'):string {
  if (/\p{Extended_Pictographic}/u.test(icon) && icon.length<=16) return icon;
  const label=name.toLowerCase();
  if(/plant|garden|watering/.test(label))return '🪴';
  if(/calori|meal|food|recipe|nutrition/.test(label))return '🍽️';
  if(/budget|money|expense|finance/.test(label))return '💰';
  if(/fitness|workout|exercise/.test(label))return '💪';
  if(/travel|trip/.test(label))return '🧳';
  if(/music|playlist/.test(label))return '🎵';
  if(/book|read|library/.test(label))return '📚';
  if(/note|journal|diary/.test(label))return '📓';
  if(/habit|task|todo/.test(label))return '✅';
  return ({leaf:'🪴',book:'📚',check:'✅',home:'🏡',spark:'✨',grid:'🧩'} as Record<string,string>)[icon] || '🧩';
}
