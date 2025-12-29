document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('schedule-container');

    if (container) {
        fetch('/api/missas')
            .then(res => res.json())
            .then(data => {
                if (data.missas.length === 0) {
                    container.innerHTML = '<p>Nenhuma missa cadastrada.</p>';
                    return;
                }
                
                let html = '';
                data.missas.forEach(missa => {
                    const [ano, mes, dia] = missa.date.split('-');
                    const dataFormatada = `${dia}/${mes}/${ano}`;

                    // Usa o título que veio do backend (personalizado ou padrão)
                    html += `
                    <article>
                        <header>
                            <strong>${dataFormatada} - ${missa.title}</strong>
                            <span style="float: right; font-size: 0.8em;">${missa.time}</span>
                        </header>
                        <div class="grid">`;
                    
                    missa.slots.forEach(slot => {
                        let content = '';
                        if (slot.acolyte) {
                            const style = slot.is_mine ? 'background-color: #2e7d32; color: white;' : '';
                            const removeBtn = slot.is_mine ? 
                                `<a href="#" onclick="alert('Vá em Minha Escala para liberar sua vaga.'); return false;" style="color: white; float:right;">✕</a>` : '';
                            
                            content = `
                                <div style="padding: 10px; border: 1px solid #444; border-radius: 5px; ${style}">
                                    <small>${slot.role}</small><br>
                                    <strong>${slot.acolyte}</strong>
                                    ${removeBtn}
                                </div>`;
                        } else {
                            content = `
                                <div role="button" class="outline" 
                                     onclick="inscrever(${slot.vaga_id})" 
                                     style="padding: 10px; text-align: center; cursor: pointer;">
                                    <small>${slot.role}</small><br>
                                    <span>Disponível</span>
                                </div>`;
                        }
                        html += content;
                    });
                    html += `</div></article>`;
                });
                container.innerHTML = html;
            });
    }
});

function inscrever(id) {
    if(!confirm("Deseja assumir esta vaga em honra a São Tarcísio?")) return;
    
    fetch(`/api/inscrever-vaga/${id}`, { method: 'POST' })
        .then(res => res.json())
        .then(res => {
            if(res.status === 'sucesso') {
                window.location.reload();
            } else {
                alert(res.message);
            }
        });
}