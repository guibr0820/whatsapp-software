const test=require('node:test');
const assert=require('node:assert/strict');
const {createAppointmentFunctions,normalizeDate}=require('../src/appointments');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
function fixture(){
  const data=new Map();const stamp=value=>({toMillis:()=>value});
  const save=(path,value,options)=>{const clean=Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined));data.set(path,options?.merge?{...data.get(path),...clean}:clean);};
  const snap=path=>({exists:data.has(path),id:path.split('/').at(-1),data:()=>data.get(path)});
  const ref=path=>({path,collection:name=>collection(`${path}/${name}`),get:async()=>snap(path),set:async(v,o)=>save(path,v,o)});
  const collection=(path,filters=[],maximum=Infinity)=>({doc:id=>ref(`${path}/${id}`),where:(field,op,value)=>collection(path,[...filters,[field,value]],maximum),limit:n=>collection(path,filters,n),get:async()=>({docs:[...data.keys()].filter(k=>k.startsWith(path+'/')&&k.split('/').length===path.split('/').length+1&&filters.every(([f,v])=>data.get(k)[f]===v)).slice(0,maximum).map(snap)})});
  const db={doc:ref,runTransaction:async fn=>fn({get:r=>r.get(),set:(r,v,o)=>save(r.path,v,o)})};
  const admin={firestore:{FieldValue:{serverTimestamp:()=>stamp(Date.now()),delete:()=>undefined},Timestamp:{fromDate:d=>stamp(d.getTime())}}};
  const date=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
  data.set('organizations/org',{proprietario_uid:'owner'});
  data.set('organizations/org/members/owner',{status:'active'});
  data.set('organizations/org/members/member',{status:'active'});
  data.set('organizations/org/professionals/p',{name:'Ana',active:true,allow_online_booking:true,schedule_active:true,service_ids:['s'],work_days:[0,1,2,3,4,5,6],work_start:'08:00',work_end:'18:00',interval_minutes:30});
  data.set('organizations/org/appointments/a',{customer_name:'Cliente',customer_phone:'5511999999999',professional_id:'p',professional:'Ana',service:'Consulta',appointment_date:date,appointment_time:'10:00',duration_minutes:60,status:'confirmed'});
  data.set(`organizations/org/booking_days/p_${date}`,{reservations:{a:{start:600,end:660}}});
  const api=createAppointmentFunctions({db,admin,onCall:(_,fn)=>fn,HttpsError});
  const request=(extra={},uid='owner')=>({auth:{uid},data:{organizationId:'org',appointmentId:'a',...extra}});
  return {api,data,date,request};
}
test('normaliza datas antigas e rejeita datas impossíveis',()=>{assert.equal(normalizeDate('26/10/2026'),'2026-10-26');assert.throws(()=>normalizeDate('2026-02-31'));});
test('lista agendamentos da empresa e bloqueia alterações para membro sem propriedade',async()=>{
  const {api,date,request}=fixture();
  const list=await api.listAppointments(request({date},'member'));assert.equal(list.appointments.length,1);assert.equal(list.canManage,false);
  await assert.rejects(api.updateAppointment(request({action:'cancel'},'member')),e=>e.code==='permission-denied');
  await assert.rejects(api.listAppointments({data:{organizationId:'org'}}),e=>e.code==='unauthenticated');
});
test('cancelamento libera a reserva e impede nova alteração do mesmo estado',async()=>{
  const {api,data,date,request}=fixture();await api.updateAppointment(request({action:'cancel'}));
  assert.equal(data.get('organizations/org/appointments/a').status,'cancelled');assert.deepEqual(data.get(`organizations/org/booking_days/p_${date}`).reservations,{});
  await assert.rejects(api.updateAppointment(request({action:'complete'})),e=>e.code==='failed-precondition');
});
test('remarcação valida conflitos e atualiza horário e versão do lembrete',async()=>{
  const {api,data,date,request}=fixture();
  data.set('organizations/org/appointments/b',{professional_id:'p',appointment_date:date,appointment_time:'11:00',duration_minutes:60,status:'confirmed'});
  const slots=await api.getAppointmentSlots(request({date}));assert.ok(!slots.times.includes('11:00'));assert.ok(slots.times.includes('14:00'));
  await assert.rejects(api.updateAppointment(request({action:'reschedule',date,time:'11:00'})),e=>e.code==='failed-precondition');
  assert.equal(data.get('organizations/org/appointments/a').appointment_time,'10:00');
  await api.updateAppointment(request({action:'reschedule',date,time:'14:00'}));
  const a=data.get('organizations/org/appointments/a');assert.equal(a.appointment_time,'14:00');assert.ok(a.reminder_revision);assert.equal(data.get(`organizations/org/booking_days/p_${date}`).reservations.a.start,840);
});
test('concluir atendimento mantém histórico e funciona mesmo após remover o profissional',async()=>{
  const {api,data,request}=fixture();data.delete('organizations/org/professionals/p');await api.updateAppointment(request({action:'complete'}));assert.equal(data.get('organizations/org/appointments/a').status,'completed');
});
