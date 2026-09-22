// aquarium-ui-tabs.js
// Tiny top-level panel tab controller. It has no aquarium knowledge and deliberately does not
// rebuild tab contents; expensive views can subscribe/unsubscribe from onChange.
export function createAquariumTabs({host,panes,initial='tank',onChange=()=>{}}={}){
  const ids=Object.keys(panes);let current=ids.includes(initial)?initial:ids[0];host.innerHTML='';const buttons={};
  for(const id of ids){const b=document.createElement('button');b.type='button';b.textContent=id[0].toUpperCase()+id.slice(1);b.dataset.tab=id;b.onclick=()=>select(id);host.appendChild(b);buttons[id]=b;}
  function select(id){if(!panes[id])return;current=id;for(const k of ids){panes[k].hidden=k!==id;buttons[k].classList.toggle('active',k===id);}onChange(id);}
  select(current);return{select,get current(){return current;},buttons};
}
