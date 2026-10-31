# Auditoria Firestore — Cardápio e pedidos

## Instância

- Banco: `default`
- Edição: Enterprise / Native Mode
- Região: `southamerica-east1`

## Modelo novo

- `organizations/{organizationId}/menu_categories/{categoryId}`: nome, descrição, estado e auditoria.
- `organizations/{organizationId}/menu_items/{productId}`: produto, preço em centavos, imagem, disponibilidade, IDs da Meta e estado de sincronização.
- `organizations/{organizationId}/catalog_config/meta`: ID e estado público do catálogo. Token Meta não é copiado para este documento.
- `organizations/{organizationId}/orders/{orderId}`: carrinho recebido pelo webhook, cliente, itens, total e estado operacional.

## Acesso e consultas

- Todas as leituras e gravações dessas coleções passam por Cloud Functions autenticadas.
- O navegador não consulta diretamente as coleções novas.
- As regras existentes terminam em `deny all`, portanto não foi necessário abrir novos caminhos no Firestore.
- As funções confirmam perfil, vínculo ativo, organização e, nas mutações, propriedade da empresa.
- Segredos e `access_token` permanecem em `integrations/whatsapp`, caminho inacessível pelo SDK do cliente.
- Consultas: categorias e itens ordenados por `name`; pedidos ordenados por `created_at`; unicidade por `name_key` e `retailer_id`; vínculo de produto por `category_id`.

## Simulação adversarial

1. Leitura pública/listagem: negada pelas regras.
2. Acesso de usuário de outra empresa: negado pela autorização das callables.
3. Escrita direta pelo cliente: negada pelas regras.
4. Alteração de organização/owner: os documentos novos não aceitam campos de autorização do cliente.
5. Strings ou imagens excessivas: limites aplicados no backend; imagem limitada a 5 MB.
6. Tipos inválidos e valores negativos: preços, quantidades, estados e IDs são normalizados e limitados.
7. Poluição de esquema: o backend constrói os objetos persistidos a partir de campos permitidos.
8. Transição após pedido encerrado: pedidos concluídos/cancelados não podem voltar ao fluxo operacional.
9. Vazamento de token Meta: respostas públicas são selecionadas campo a campo e erros removem credenciais longas.
10. Subcoleção órfã: a autorização exige que organização e membro existam.
11. Escalada de privilégio: somente o proprietário altera cardápio e estado do pedido.
12. Replay do webhook: o ID determinístico da mensagem substitui o mesmo pedido, sem duplicá-lo.

## Observação

Este documento cobre o modelo do cardápio. As regras completas do projeto devem continuar sendo revisadas sempre que uma coleção passar a ser acessada diretamente pelo cliente.
