INSERT INTO dentista_config (dentist_person_id, dentist_name, keyword_despesa, persona_avaliacao_id)
VALUES
  ('5042763376230400', 'Helen Cristina Fernandes Toledo dos Santos', 'Helen',          NULL),
  ('5586992929308672', 'Ana Luiza Rodrigues Coelho',                 'Ana Luiza',      NULL),
  ('4661396421345280', 'Thais Cristina Madeira Finamore',            'Thais',          NULL),
  ('6658758799917056', 'Raíssa Alves Lopes',                         'Raissa',         NULL),
  ('5434303083839488', 'Joaquim Vidigal Martins Filho',              'Joaquim',        NULL),
  ('6341915044610048', 'Fernanda Martins Cardoso',                   'Fernanda',       NULL),
  ('5560570007322624', 'Hemylly Vitoria Albino Ferreira',            'Hemylly',        NULL),
  ('4605642465476608', 'Milena Aguiar de Souza Almeida',             'Milena',         NULL),
  ('6735291943092224', 'Amanda Ferreira Molica',                     'Amanda',         NULL),
  ('5921107573866496', 'Lorena Ventura Fernandes',                   'Lorena Ventura', NULL),
  ('5387117075103745', 'Lígia Quintão Mayrink Soares',               'Ligia',          NULL),
  ('5510456402640896', 'Patrícia Reis de Sá',                        'Patricia',       NULL),
  ('6513323816124416', 'Felipe Henrique do Carmo Silva',             'Felipe',         NULL)
ON CONFLICT (dentist_person_id) DO NOTHING;
