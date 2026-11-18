/* ============================================================
   Startlisten — de 55 søknadene appen ble født med.

   Brukes bare når det verken finnes en datafil eller noe i
   localStorage, og av «Tilbakestill til startlisten».
   Rekkefølge: [selskap, stilling, lenke, sted, frist, status, sektor, notat]
   ============================================================ */

export const START = [
  // ---- å søke på, med frist ----
  ["Aker BP","Graduate: Life Cycle Data Services","https://akerbp.com/en/available-positions/graduate-2027-life-cycle-data-services-2/","Oslo / Trondheim","2026-08-28","todo","energi",""],
  ["Kongsberg","Software Engineer, Signal Processing","https://www.kongsberg.com/careers/vacancies/software-engineer---signal-processing/","Horten","2026-08-30","todo","energi",""],
  ["Bouvet","Data- og analyseplattformer","https://www.bouvet.no/bli-en-av-oss/ledige-stillinger/arkitekter-radgivere-og-utviklere-for-moderne-data-og-analyseplattformer-708","Oslo","2026-08-31","todo","konsulent",""],
  ["Cogito NTNU","Opptak høst 2026","","Trondheim","2026-08-28","todo","studentorg",""],
  ["Visma","Summer internship 2027","https://vismasoftwareinternationalas.teamtailor.com/jobs/8083982-your-future-in-tech-is-calling-will-you-answer","Oslo","2026-09-13","todo","teknologi","frist kl. 12:00"],
  ["Sopra Steria","Data Science / ML Engineer","https://careers.soprasteria.no/job/data-science-ml-engineer-in-oslo-norway-jid-7493","Oslo","2026-09-13","todo","konsulent",""],
  ["Sopra Steria","Data Engineer","https://careers.soprasteria.no/job/data-engineer-in-oslo-norway-jid-7465","Oslo","2026-09-13","todo","konsulent",""],
  ["Implement Consulting","Graduates to join Oslo office","https://implementconsultinggroup.com/job/0816d10f-5621-4164-bf13-bd52cf2515f9/744000135203234","Oslo","2026-09-13","todo","konsulent",""],
  ["Implement Consulting","Junior Consultant","https://implementconsultinggroup.com/job/3c5ba478-be63-4102-aaab-af098681d230/744000135209239","Oslo","2026-09-13","todo","konsulent",""],
  ["Capgemini","frog graduate-program","https://www.capgemini.com/no-no/jobs/514983-en_US+sap_btp","Oslo","2026-09-14","todo","konsulent",""],
  ["Intility","Tech Graduate 2027","https://career.intility.com/jobs/8205571-tech-graduate-2027","Oslo","2026-09-24","todo","teknologi",""],
  ["Bouvet","Utviklere, AI-drevne prosesser","https://www.bouvet.no/bli-en-av-oss/ledige-stillinger/vi-soker-utviklere-med-lidenskap-for-ai-drevne-utviklingsprosesser-980","Trondheim","2026-09-30","todo","konsulent",""],
  ["Bekk","Nyutdannede, data og analyse","https://www.bekk.no/jobb/34a4809e-7051-4b4b-9fc2-50d4b09145d7","Oslo","2026-09-30","todo","konsulent",""],
  ["Bekk","Sommerjobb, data og analyse","https://www.bekk.no/jobb/d232a08b-d1d0-4ec2-bfdd-ebc1ee000e70","Oslo","2026-09-30","todo","konsulent",""],
  ["Bekk","Nyutdannede utviklere","https://www.bekk.no/jobb/acde2cc6-1b4c-4117-b87f-9efd96430cdf","Trondheim","2026-09-30","todo","konsulent",""],
  ["Bekk","Sommerjobb utviklere","https://www.bekk.no/jobb/d3daac89-2b14-46c2-b275-9cac8cbea1d4","Trondheim","2026-09-30","todo","konsulent",""],
  ["Bekk","Nyutdannede utviklere","https://www.bekk.no/jobb/19e99eb8-c21e-4b7d-84c1-bbc00b8065aa","Oslo","2026-09-30","todo","konsulent",""],
  ["Bekk","Sommerjobb utviklere","https://www.bekk.no/jobb/74bf105e-e315-4206-902e-4527d376b487","Oslo","2026-09-30","todo","konsulent",""],
  ["Sopra Steria","Nyutdannet Teknologi 2027","https://jobs.smartrecruiters.com/SopraSteria1/744000140886019-nyutdannet-teknologi-2027","","2026-10-01","todo","konsulent",""],
  ["DNB","Greenhouse: Arkitektur og utvikling","https://jobb.dnb.no/job/Bj%C3%B8rvika-%28N001%29-DNB-Greenhouse-Graduate-program-Arkitektur-og-utvikling-2027-0191/1426583933/","Oslo","2026-10-01","todo","finans",""],
  ["DNB","Greenhouse: Cyber security","https://jobb.dnb.no/job/Bj%C3%B8rvika-%28N001%29-DNB-Greenhouse-Graduate-program-Cyber-security-0191/1426584133/","Oslo","2026-10-01","todo","finans",""],
  ["Equinor","Summer internship","https://www.equinor.com/careers/summer-interns","","2026-10-15","todo","energi","åpner 25.09"],
  // ---- løpende ----
  ["Cognite","Data Scientist","https://job-boards.eu.greenhouse.io/cognite/jobs/4943678101","Oslo",null,"todo","teknologi",""],
  ["Cognite","Data Engineer","https://job-boards.eu.greenhouse.io/cognite/jobs/4873575101","Oslo",null,"todo","teknologi",""],
  ["Autodesk","Graduate Software Engineer","https://autodesk.wd1.myworkdayjobs.com/en-US/Ext/details/Graduate-Software-Engineer_26WD100002-1?locationCountry=d07f8ca8625e4345b98a91d0558b872a","Oslo",null,"todo","teknologi",""],
  ["Capgemini","Nyutdannet: Data Engineer / Analyst","https://www.capgemini.com/no-no/jobs/515007-en_US+sap_btp","Oslo",null,"todo","konsulent",""],
  ["Capgemini","Nyutdannet: Software Engineer","https://www.capgemini.com/no-no/jobs/513664-en_US+sap_btp","Oslo / Trondheim",null,"todo","konsulent",""],
  ["McKinsey","Associate","https://www.mckinsey.com/careers/search-jobs/jobs/associate-15178","Oslo",null,"todo","konsulent",""],
  ["Bain","Consultant","https://www.bain.com/careers/find-a-role/position/?jobid=10409","Oslo",null,"todo","konsulent",""],
  ["Bain","Associate Consultant","https://www.bain.com/careers/find-a-role/position/?jobid=10397","Oslo",null,"todo","konsulent",""],
  // ---- sendt ----
  ["Aker BP","Graduate: Data Engineer / Digital","https://akerbp.com/en/available-positions/graduate-2027-data-engineer-digital-2/","Trondheim / Fornebu",null,"sent","energi",""],
  ["Equinor","Graduate: IT & Cybernetics","https://equinor.wd3.myworkdayjobs.com/en-US/EQNR/details/Job-Posting-Title-Graduate-Programme-2027-Norway---IT---Cybernetics_JR107220?q=graduate","Trondheim / Oslo",null,"sent","energi",""],
  ["Statnett","Data Scientist","https://903000.webcruiter.no/Main2/recruit/public/5150514100?&language=&use_position_site_header=0&url_org=903000","Oslo",null,"sent","energi",""],
  ["DNV","ML Engineer, Generative AI","https://jobs.dnv.com/job-search/energy-systems/it-and-software/barcelona-spain-oslo-norway-milano-lombardia-italy-bristol/ml-engineer-generative-ai/300001513323131","Oslo",null,"sent","energi",""],
  ["NBIM","Graduate-programmet, AI","https://www.nbim.no/no/om-oss/jobb-i-oljefondet/graduate-program/","Oslo",null,"sent","finans",""],
  ["McKinsey","Junior Associate, Tech & AI","https://www.mckinsey.com/careers/search-jobs/jobs/juniorassociate-techai-103060","Oslo",null,"sent","konsulent",""],
  ["McKinsey","Junior Associate","https://www.mckinsey.com/careers/search-jobs/jobs/juniorassociate-20159","Oslo",null,"sent","konsulent",""],
  ["McKinsey","Associate Intern","https://www.mckinsey.com/careers/search-jobs/jobs/associateintern-14918","Oslo",null,"sent","konsulent",""],
  ["Bain","Associate Consultant Internship","https://www.bain.com/careers/work-with-us/internships-programs/associate-consultant-internship/","Oslo",null,"sent","konsulent",""],
  ["Bain","Bainworks","","Oslo",null,"sent","konsulent",""],
  ["Accenture","Graduate 2027","https://www.accenture.com/no-en/careers/jobdetails?id=R00339346_en","Oslo",null,"sent","konsulent",""],
  ["Deloitte","Nyutdannet: data, AI og innovasjon","https://jobs.smartrecruiters.com/oneclick-ui/company/DeloitteNordic/publication/f838ae0a-0dde-4705-a2f1-fad1dbc00103?dcr_ci=DeloitteNordic","Oslo",null,"sent","konsulent",""],
  ["KPMG","Nyutdannet: teknologi og sikkerhet","https://emp.jobylon.com/jobs/359958-kpmg-norge-nyutdannet-i-2027-og-nysgjerrig-pa-a-jobbe-med-teknologi-og-sikkerhet-i-kpmg/","Oslo",null,"sent","konsulent",""],
  ["BearingPoint","Technology, nyutdannet","https://www.bearingpoint.com/en-no/careers/ledige-stillinger/offer/?id=T8155108&country=NO","Oslo",null,"sent","konsulent",""],
  ["Capgemini","Nyutdannet: IT-prosjektledelse","https://www.capgemini.com/no-no/jobs/512933-en_US+sap_btp","Oslo",null,"sent","konsulent",""],
  ["Sopra Steria","Sommerjobb Teknologi 2027","https://jobs.smartrecruiters.com/SopraSteria1/744000140895809-sommerjobb-teknologi-2027","Oslo",null,"sent","konsulent",""],
  ["Sprint","Nyutdannet, oppstart høst 2027","https://karriere.sprint.no/companies/cm7y44jp0022tityin97d38jh/cmqumfvze00rp0ls6zzl95ik3","Oslo",null,"sent","konsulent",""],
  ["Revolve NTNU","Autonomous systems","","Trondheim",null,"sent","studentorg",""],
  ["Njord NTNU","Software","https://www.njordchallenge.com/positions/software","Trondheim",null,"sent","studentorg",""],
  ["Jr Consulting","Opptak","","Trondheim",null,"sent","studentorg",""],
  // ---- avgjort / arkiv ----
  ["NTNUI Tennis","Styreverv","","Trondheim",null,"accepted","studentorg","tatt opp"],
  ["Sopra Steria","AI Engineer","https://careers.soprasteria.no/job/ai-engineer-in-oslo-norway-jid-7491","Oslo",null,"rejected","konsulent",""],
  ["Norconsult","AI Engineer","https://norconsult.com/career/job-vacancies/req-6215/","","2026-08-20","expired","energi","rakk ikke fristen"],
  ["Capgemini","Invent graduate-program","https://www.capgemini.com/no-no/jobs/514968-en_US+sap_btp","","2026-08-23","expired","konsulent","rakk ikke fristen"],
  ["PwC","Data","https://emp.jobylon.com/jobs/369859-pwc-norway-vil-du-hjelpe-norges-ledende-virksomheter-realisere-kraften-i-data/","Trondheim","2026-08-17","expired","konsulent","rakk ikke fristen"]
];
