async function discoverAuthorizedCatalogs({axios, version, accessToken, integration}) {
  const base = `https://graph.facebook.com/${version}/`;
  async function rows(path, token = accessToken, fields = 'id,name,vertical') {
    const result = []; let after;
    for(let page=0;page<20;page++) {
      const response = await axios.get(base+path,{headers:{Authorization:`Bearer ${token}`},params:{fields,limit:100,...(after?{after}:{})},timeout:15000});
      result.push(...(response.data?.data || []));
      if(!response.data?.paging?.next)return result;
      after=response.data.paging.cursors?.after;
      if(!after)throw new Error('A Meta não retornou a paginação dos catálogos.');
    }
    throw new Error('Há muitos ativos disponíveis. Restrinja a autorização ao portfólio da empresa.');
  }
  const linked = await rows(`${integration.waba_id}/product_catalogs`,integration.access_token);
  if(linked.length) return linked.map(item=>({id:String(item.id),name:item.name || 'Catálogo',linked:true}));
  let owner;
  try {
    const response=await axios.get(base+integration.waba_id,{headers:{Authorization:`Bearer ${integration.access_token}`},params:{fields:'owner_business_info'},timeout:15000});
    owner=response.data?.owner_business_info?.id;
  } catch { /* Some shared WABAs do not expose their owner. Ask the user to select. */ }
  const businesses=owner ? [{id:owner}] : await rows('me/businesses',accessToken,'id,name');
  const found = new Map();
  for(const business of businesses) {
    let accessible=false;
    for(const edge of ['owned_product_catalogs','client_product_catalogs']) {
      try {
        for(const item of await rows(`${business.id}/${edge}`)) found.set(String(item.id),{id:String(item.id),name:item.name || 'Catálogo',businessName:business.name || '',linked:false,ownerMatched:Boolean(owner)});
        accessible=true;
      } catch(error) { if(![400,403].includes(error.response?.status))throw error; }
    }
    if(owner && !accessible)throw new Error('Autorize o acesso aos catálogos do portfólio vinculado ao WhatsApp.');
  }
  return [...found.values()];
}
async function ensureCatalogLinked({axios,version,accessToken,wabaId,catalogId}) {
  const url=`https://graph.facebook.com/${version}/${wabaId}/product_catalogs`;
  const headers={Authorization:`Bearer ${accessToken}`};
  const response=await axios.post(url,new URLSearchParams({catalog_id:String(catalogId)}),{headers:{...headers,'Content-Type':'application/x-www-form-urlencoded'},timeout:15000});
  if(response.data?.success !== true)throw new Error('A Meta não confirmou a solicitação de vínculo do catálogo. Tente novamente.');
}
module.exports={discoverAuthorizedCatalogs,ensureCatalogLinked};
