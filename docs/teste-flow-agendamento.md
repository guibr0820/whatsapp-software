# Teste do Flow de agendamento

O JSON padrão está em `functions/src/appointment-flow.json`. Ele foi adaptado do Flow Serviços da barbearia para usar Profissional. Os dados vêm das coleções da empresa no clickchat. O Flow publicado anteriormente na barbearia permanece no endpoint original.

## Chave e publicação

Como o mesmo número já usa Flows da barbearia, copie **a mesma chave privada** do segredo `WHATSAPP_FLOW_PRIVATE_KEY` daquele backend para o segredo com o mesmo nome no projeto clickchat. Não substitua a chave do número por outra: isso interromperia os outros Flows. Não envie a chave no chat e não a inclua no código.

```powershell
firebase functions:secrets:set WHATSAPP_FLOW_PRIVATE_KEY --project whatsapp-software-a85f3
firebase deploy --only functions:bookingFlowEndpoint,functions:createAppointmentFlow,functions:saveWhatsAppFlowConfig,functions:sendWhatsAppFlow,functions:metaWebhook,functions:sendAppointmentReminderTask --project whatsapp-software-a85f3
```

Endpoint do novo Flow:

`https://southamerica-east1-whatsapp-software-a85f3.cloudfunctions.net/bookingFlowEndpoint`

A criação de um agendamento no painel gera um novo Flow com esse endpoint. Confere a chave pública existente e só a cadastra se o número ainda não tiver uma. Uma chave diferente interrompe a criação com uma mensagem explicativa.

## Preparação

1. Cadastre serviços e adicionais ativos com duração e preço.
2. Cadastre funcionários ativos, associe os serviços e configure dias, jornada, intervalo e pausas. Ative agendamento online.
3. Em Automações, use Criar agendamento. Os novos Flows usam dados dinâmicos; modelos antigos continuam com o endpoint e comportamento originais.
4. Selecione o novo Flow, escreva a mensagem e o botão, marque Disponível para envio e salve. Esse Flow passa a ser o padrão do menu automático da empresa. Desmarcar e salvar desativa o menu desse Flow.
5. Configure o lembrete aprovado e o atraso após confirmação, se quiser testá-lo.

## Teste real

1. De outro WhatsApp, envie `menu` para o número conectado.
2. Receba os botões Agendar horário, Meus agendamentos e Falar com atendente.
3. Toque em Agendar horário. Também é possível enviar `agendar teste`.
4. Abra o Flow, selecione serviço, opcionais, profissional, data e horário. Confirme nome e resumo.
5. Confira a confirmação no WhatsApp e o documento na coleção appointments da empresa.
6. Confira o lembrete após o atraso configurado.
7. Tente reservar o mesmo intervalo em outra sessão: ele não deve ser oferecido ou deve ser recusado ao confirmar.
8. Meus agendamentos lista os próximos horários confirmados. Falar com atendente suspende respostas automáticas até o cliente enviar menu, inicio ou voltar.

## Comportamento

- Confirmação automática no primeiro teste; aprovação manual e pagamento não fazem parte desta implementação.
- Sessões expiram em 30 minutos e são vinculadas à empresa e ao telefone no servidor.
- Agenda considera duração total, pausas, férias, dias de trabalho, horários passados e reservas existentes.
- A gravação usa transação com trava por profissional e data e um ID por sessão, evitando reserva duplicada por reenvio.
- O webhook só responde 200 depois de persistir e processar o evento. Eventos já processados não acionam o menu novamente.
- Atualizar catálogo não exige republicar o JSON dinâmico.
- A disponibilidade usa America/Sao_Paulo e janela de 30 dias nesta versão.
- Cancelamento/remarcação pelo Flow Meus agendamentos e confirmação manual ficam para etapa posterior.
