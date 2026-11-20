# Planejamento: orçamento e execução de serviços profissionais

Este documento registra decisões de produto em discussão. As etapas descritas aqui ainda precisam ser implementadas e testadas.

## Atendimento e avaliação

- O cliente escolhe uma ocupação no WhatsApp e descreve sua necessidade. A equipe decide entre continuar o orçamento pela conversa ou oferecer uma visita técnica.
- Quando necessária, a visita técnica é agendada com endereço, profissional, data e horário. O profissional pode avaliar e executar na mesma visita ou retornar em outro dia combinado com o cliente.
- Também pode haver um orçamento acertado pela conversa antes da visita, sem exigir uma visita apenas de avaliação.

## Orçamento

- Permitir que a equipe registre o serviço, valor da mão de obra e valor dos materiais. O total é calculado pela soma; materiais podem valer R$ 0,00.
- Permitir salvar como rascunho e revisar o resumo antes do envio.
- Enviar ao cliente no WhatsApp o serviço, mão de obra, materiais e total, seguidos da pergunta: “Você confirma este orçamento?”
- Oferecer as respostas “Sim, confirmo” e “Não, conversar”. A primeira registra a aprovação; a segunda devolve o atendimento à equipe para negociação. Se os valores mudarem, enviar uma nova versão para confirmação.
- O registro deve preservar qual versão foi apresentada e confirmada, sem tratar uma aprovação anterior como aprovação de novos valores.

## Execução

- Após a confirmação do orçamento, oferecer “Realizar agora” para continuar no mesmo atendimento ou “Agendar execução” para registrar o dia e horário acordados presencialmente com o cliente.
- O retorno para execução é um novo agendamento vinculado à visita e ao orçamento, reaproveitando os dados do cliente e endereço, com possibilidade de conferência e alteração.
- Permitir registrar o orçamento e agendar a execução mesmo quando o acordo começou pela conversa, sem forçar uma visita de avaliação.

## Pagamento Pix

- Disponibilizar no atendimento um botão “Gerar Pix” com ícone Pix, para enviar a cobrança ao cliente pelo WhatsApp.
- Antes do envio, apresentar o valor para conferência. Identificar o pagamento confirmado e o saldo pendente, sem considerar um Pix apenas gerado como pago.
- A integração existente já possui uma ação de cobrança por Pix para agendamentos; verificar sua reutilização para o orçamento e a execução, incluindo saldos e prevenção de cobranças duplicadas, durante a implementação.
- Definir os detalhes de cobrança parcial, vencimento e cancelamento antes de implementar esses casos.
