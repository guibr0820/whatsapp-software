const test=require('node:test');
const assert=require('node:assert/strict');
const {discoverAuthorizedCatalogs,ensureCatalogLinked}=require('../src/catalog-discovery');
const integration={waba_id:'waba',access_token:'whatsapp-token'};
const run=axios=>discoverAuthorizedCatalogs({axios,version:'v24.0',accessToken:'catalog-token',integration});
test('vincula e confirma usando a mesma credencial autorizada ao catálogo',async()=>{
  const calls=[];
  const axios={post:async(url,body,options)=>{calls.push('post');assert.equal(body.get('catalog_id'),'catalog');assert.equal(options.headers.Authorization,'Bearer catalog-token');return {data:{success:true}};},get:async()=>{throw new Error('A leitura eventualmente inconsistente não deve invalidar o sucesso da operação.');}};
  await ensureCatalogLinked({axios,version:'v24.0',accessToken:'catalog-token',wabaId:'waba',catalogId:'catalog'});
  assert.deepEqual(calls,['post']);
  axios.post=async()=>({data:{success:false}});
  await assert.rejects(ensureCatalogLinked({axios,version:'v24.0',accessToken:'catalog-token',wabaId:'waba',catalogId:'catalog'}),/não confirmou/);
});
test('prioriza catálogo já vinculado à WABA sem buscar ativos de outros portfólios',async()=>{
  const paths=[];
  const result=await run({get:async(url,options)=>{paths.push(url);assert.equal(options.headers.Authorization,'Bearer whatsapp-token');return {data:{data:[{id:'1',name:'Lanchonete'}]}};}});
  assert.deepEqual(result,[{id:'1',name:'Lanchonete',linked:true}]);assert.equal(paths.length,1);
});
test('catálogo recém-criado é descoberto no portfólio dono da WABA com paginação',async()=>{
  const result=await run({get:async(url,{params,headers})=>{
    if(url.endsWith('waba/product_catalogs'))return {data:{data:[]}};
    if(url.endsWith('/waba'))return {data:{owner_business_info:{id:'owner'}}};
    assert.equal(headers.Authorization,'Bearer catalog-token');
    assert.ok(!url.includes('me/businesses'));
    if(url.endsWith('client_product_catalogs'))return {data:{data:[]}};
    assert.ok(url.includes('/owner/'));
    return params.after ? {data:{data:[{id:'2',name:'Novo catálogo'}]}} : {data:{data:[{id:'1',name:'Antigo'}],paging:{next:'unused',cursors:{after:'page2'}}}};
  }});
  assert.deepEqual(result.map(x=>x.id),['1','2']);assert.ok(result.every(x=>x.ownerMatched));
});
test('sem dono identificável exige seleção explícita, mesmo com uma opção',async()=>{
  const result=await run({get:async(url)=>{
    if(url.endsWith('waba/product_catalogs'))return {data:{data:[]}};
    if(url.endsWith('/waba'))return {data:{}};
    if(url.endsWith('me/businesses'))return {data:{data:[{id:'business',name:'Empresa autorizada'}]}};
    if(url.endsWith('owned_product_catalogs'))return {data:{data:[{id:'1',name:'Cardápio'}]}};
    return {data:{data:[]}};
  }});
  assert.equal(result[0].ownerMatched,false);assert.equal(result[0].businessName,'Empresa autorizada');
});
