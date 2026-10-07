// DEMO FIXTURES — fictional people and records for development, demonstrations
// and tests. Never hospital data, never policy, never loaded in production.
// Carried over from the V04 seed (docs/SEED_DATA_INVENTORY.md §7), which took
// them from V03 app/src/data/seed.ts, with the defects found on 2026-09-23 fixed:
//   - credential statuses are derived from their dates by the loader, not stored here;
//   - every credential carries the tracked fields its type requires (fictional values);
//   - no contract is set to Superseded by hand (D-29): 3006's is Expired;
//   - contracts record a creator and a different approver (D-30).

export interface DemoEmployee {
  jobNumber: string; firstName: string; middleName?: string; lastName: string;
  jobTitle: string; fileNo: string; rankGradeCode: string; nationalityCode: string; // ISO 3166-1 alpha-3 (the nationality list)
  jobPostCity: string; /* a Qassim city of the location master */ specialtyCode: string; // the Nursing Specialty master
  maritalStatus: 'Single' | 'Married' | 'Others'; salary: number;
  positionCode: string; unitCode: string; contactEmail: string; hireDate: string;
}

export const DEMO_EMPLOYEES: DemoEmployee[] = [
  { jobNumber: '1001', firstName: 'Sarah', middleName: 'Ahmed', lastName: 'Al-Harbi', jobTitle: 'Registered Nurse', fileNo: '1001', rankGradeCode: 'N03', nationalityCode: 'SAU', jobPostCity: 'Buraydah', specialtyCode: 'NS003', maritalStatus: 'Single', salary: 8500, positionCode: 'SN', unitCode: 'ICU_MAIN', contactEmail: 'sarah.ahmed@aigh.sa', hireDate: '2023-01-15' },
  { jobNumber: '1002', firstName: 'Mohammed', middleName: 'Al-Rashid', lastName: 'Al-Qahtani', jobTitle: 'Head Nurse', fileNo: '1002', rankGradeCode: 'N02', nationalityCode: 'SAU', jobPostCity: 'Buraydah', specialtyCode: 'NS002', maritalStatus: 'Married', salary: 12000, positionCode: 'HN', unitCode: 'WARD_3A', contactEmail: 'm.alrashid@aigh.sa', hireDate: '2022-06-01' },
  { jobNumber: '2003', firstName: 'Fatima', lastName: 'Zahra', jobTitle: 'Charge Nurse', fileNo: '2003', rankGradeCode: 'N03', nationalityCode: 'EGY', jobPostCity: 'Unaizah', specialtyCode: 'NS006', maritalStatus: 'Married', salary: 9500, positionCode: 'CN', unitCode: 'NICU', contactEmail: 'fatima.z@aigh.sa', hireDate: '2023-03-10' },
  { jobNumber: '2004', firstName: 'John', middleName: 'Michael', lastName: 'Smith', jobTitle: 'Staff Nurse', fileNo: '2004', rankGradeCode: 'N03', nationalityCode: 'USA', jobPostCity: 'Buraydah', specialtyCode: 'NS004', maritalStatus: 'Single', salary: 9000, positionCode: 'SN', unitCode: 'ER_MAIN', contactEmail: 'john.smith@aigh.sa', hireDate: '2024-01-20' },
  { jobNumber: '3005', firstName: 'Aisha', middleName: 'Khan', lastName: 'Al-Otaibi', jobTitle: 'Nurse Practitioner', fileNo: '3005', rankGradeCode: 'N02', nationalityCode: 'PAK', jobPostCity: 'Buraydah', specialtyCode: 'NS003', maritalStatus: 'Married', salary: 14000, positionCode: 'PRACTITIONER', unitCode: 'ICU_MAIN', contactEmail: 'aisha.khan@aigh.sa', hireDate: '2021-11-05' },
  { jobNumber: '3006', firstName: 'Omar', middleName: 'Hassan', lastName: 'Al-Dosari', jobTitle: 'Staff Nurse', fileNo: '3006', rankGradeCode: 'N03', nationalityCode: 'SAU', jobPostCity: 'Ar Rass', specialtyCode: 'NS013', maritalStatus: 'Single', salary: 8500, positionCode: 'SN', unitCode: 'OR', contactEmail: 'omar.hassan@aigh.sa', hireDate: '2023-07-12' },
  { jobNumber: '4007', firstName: 'Layla', lastName: 'Mahmoud', jobTitle: 'Midwife', fileNo: '4007', rankGradeCode: 'N03', nationalityCode: 'JOR', jobPostCity: 'Buraydah', specialtyCode: 'NS008', maritalStatus: 'Married', salary: 10000, positionCode: 'MW', unitCode: 'LND', contactEmail: 'layla.m@aigh.sa', hireDate: '2022-09-18' },
  { jobNumber: '4008', firstName: 'David', lastName: 'Lee', jobTitle: 'Nursing Supervisor', fileNo: '4008', rankGradeCode: 'N02', nationalityCode: 'GBR', jobPostCity: 'Buraydah', specialtyCode: 'NS027', maritalStatus: 'Married', salary: 15000, positionCode: 'NS', unitCode: 'WARD_3A', contactEmail: 'david.lee@aigh.sa', hireDate: '2020-05-22' },
];

export const DEMO_CONTRACTS = [
  { jobNumber: '1001', startDate: '2023-01-15', endDate: '2026-01-14', status: 'Expired' },
  { jobNumber: '1002', startDate: '2022-06-01', endDate: '2026-05-31', status: 'Suspended' },
  { jobNumber: '2003', startDate: '2023-03-10', endDate: '2026-03-09', status: 'Terminated' },
  { jobNumber: '2004', startDate: '2024-01-20', endDate: '2027-01-19', status: 'Active' },
  { jobNumber: '3005', startDate: '2021-11-05', endDate: '2026-11-04', status: 'Active' },
  { jobNumber: '3006', startDate: '2023-07-12', endDate: '2026-07-11', status: 'Expired' },
  { jobNumber: '4007', startDate: '2022-09-18', endDate: '2025-12-18', status: 'Expired' },
  { jobNumber: '4008', startDate: '2020-05-22', endDate: '2026-05-21', status: 'Terminated' },
] as const;

/** ILLUSTRATIVE requirements — the hospital's credential policy (U2) is not established. */
export const DEMO_REQUIREMENTS = [
  { template: 'SCFHS', unit: 'ICU_MAIN', position: null },
  { template: 'BLS', unit: 'ICU_MAIN', position: null },
  { template: 'ACLS', unit: 'ICU_MAIN', position: null },
  { template: 'IQAMA', unit: 'ICU_MAIN', position: null },
  { template: 'SCFHS', unit: 'WARD_3A', position: 'SN' },
  { template: 'BLS', unit: 'WARD_3A', position: null },
] as const;

const lifeSupport = (n: string, issue: string, expiry: string) => ({ certificate_number: n, training_provider: 'Demo Training Centre', issue_date: issue, expiry_date: expiry });
const scfhs = (n: string, issue: string, expiry: string) => ({ scfhs_number: n, classification: 'N03', issue_date: issue, expiry_date: expiry });

/**
 * Verified credentials: the loader stores Valid / ExpiringSoon / Expired from
 * the expiry date. `expiryGregorian` is converted to the Iqama's Umm al-Qura expiry field.
 * 1001's two and 1002's are past their expiry (the "expired licence" scenario);
 * 3005 holds the complete ICU set (the "eligible" scenario).
 */
export const DEMO_CREDENTIALS = [
  { jobNumber: '1001', template: 'SCFHS', trackingData: scfhs('DEMO-SCFHS-1001', '2023-01-01', '2026-06-01') },
  { jobNumber: '1001', template: 'BLS', trackingData: lifeSupport('DEMO-BLS-1001', '2024-01-01', '2026-01-01') },
  { jobNumber: '1002', template: 'SCFHS', trackingData: scfhs('DEMO-SCFHS-1002', '2023-01-01', '2025-10-15') },
  { jobNumber: '3005', template: 'SCFHS', trackingData: scfhs('DEMO-SCFHS-3005', '2025-01-01', '2027-12-31') },
  { jobNumber: '3005', template: 'BLS', trackingData: lifeSupport('DEMO-BLS-3005', '2025-06-01', '2027-06-01') },
  { jobNumber: '3005', template: 'ACLS', trackingData: lifeSupport('DEMO-ACLS-3005', '2025-06-01', '2027-06-01') },
  { jobNumber: '3005', template: 'IQAMA', trackingData: { iqama_number: 'DEMO-2000000000', sponsor: 'Demo Hospital', issue_date: '2025-01-01', job_title: 'Nurse Practitioner' }, expiryGregorian: '2027-01-01' },
] as const;

/** One login per real role (D-5). The password comes from DEMO_PASSWORD — never from source. */
export const DEMO_USERS = [
  { email: 'admin@aigh.sa', displayName: 'System Admin', role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM', scopeUnits: [] },
  { email: 'hr.admin@aigh.sa', displayName: 'HR Admin', role: 'HR_ADMIN', scopeType: 'SYSTEM', scopeUnits: [] },
  { email: 'supervisor@aigh.sa', displayName: 'David Lee', role: 'SUPERVISOR', scopeType: 'UNIT', scopeUnits: ['ICU_MAIN', 'WARD_3A', 'NICU'], employeeJobNumber: '4008' },
  { email: 'nurse@aigh.sa', displayName: 'Sarah Al-Harbi', role: null, scopeType: null, scopeUnits: [], employeeJobNumber: '1001' },
  { email: 'breakglass@aigh.sa', displayName: 'Break-glass (demo)', role: null, scopeType: null, scopeUnits: [], isBreakGlass: true },
] as const;
