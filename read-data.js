import fs from 'fs';
import jwt from 'jsonwebtoken';

const aud = 'https://deptva-eval.okta.com/oauth2/aus8nm1q0f7VQ0a482p7/v1/token'
const tokenService = 'https://sandbox-api.va.gov/oauth2/health/system/v1/token'
const fhirEndpoint = 'https://sandbox-api.va.gov/services/fhir/v0/r4'
const scope = 'launch system/AllergyIntolerance.read system/Appointment.read system/Condition.read system/Device.read system/DeviceRequest.read system/DiagnosticReport.read system/Encounter.read system/Immunization.read system/Location.read system/Medication.read system/MedicationRequest.read system/Observation.read system/Organization.read system/Patient.read system/Procedure.read'

const vaClientID = 'settings/va-client-id.txt'
const vaPrivateKey = 'settings/va-private.pem'

const signedJWT = getAssertionPrivatekey(vaClientID, vaPrivateKey, aud)

// 56 year old male Veteran
await getAllFHIRData('2000190')

// 35 year old female Veteran
// await getAllFHIRData('36000216')

// Veteran with Diabetes condition
// await getAllFHIRData('21000177')

// Veteran with Metformin meds
// await getAllFHIRData('43000341')

/*
 * Supporting functions
 */

function getAssertionPrivatekey (clientIdFile, keyFile, audience) {
  let secret = fs.readFileSync(keyFile, "utf8")
  let clientId = fs.readFileSync(clientIdFile, "utf8")

  let secondsSinceEpoch = Math.round(Date.now() / 1000);
  const claims = { 
    "aud": audience,
    "iss": clientId,
    "sub": clientId,
    "iat": secondsSinceEpoch,
    "exp": secondsSinceEpoch + 3600,
    "jti": crypto.randomUUID()
  }
  const options = {
    algorithm: 'RS256' // e.g., HS256, RS256
  }

  const signed = jwt.sign(claims, secret, options)
//   console.log("Signed JWT: ", signed);
  return signed
}

async function postDataFetch(url, data) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data), // Convert the data to a JSON string
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json(); // Await parsing the JSON body
    // console.log('Success:', result);
    return result;
  } catch (error) {
    console.error('Error:', error);
  }
}

async function getAccessToken(patientID) {
  const launchPatient = '{"patient":"' + patientID + '"}'
  const launchPatientEncoded = Buffer.from(launchPatient, "utf-8").toString("base64")

  const accessTokenData = {
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: signedJWT,
      scope: scope,
      launch: launchPatientEncoded
  }

  const token = await postDataFetch(tokenService, accessTokenData);
  // console.log(token)
  return token.access_token
}

async function getAllFHIRData(patientID) {
  const accessToken = await getAccessToken(patientID)
  const patient = await getFHIRData('Patient', patientID, accessToken)
  const condition = await getFHIRData('Condition', patientID, accessToken)
  const observation = await getFHIRData('Observation', patientID, accessToken)
  const diagnosticReport = await getFHIRData('DiagnosticReport', patientID, accessToken)
  const medicationRequest = await getFHIRData('MedicationRequest', patientID, accessToken)
  const immunization = await getFHIRData('Immunization', patientID, accessToken)
  const allergy = await getFHIRData('AllergyIntolerance', patientID, accessToken)
  const encounter = await getFHIRData('Encounter', patientID, accessToken)
  const procedure = await getFHIRData('Procedure', patientID, accessToken)
  const device = await getFHIRData('Device', patientID, accessToken)
  const deviceRequest = await getFHIRData('DeviceRequest', patientID, accessToken)

  // Read referenced Medication resources because VA does not support _include
  var medications = []
  for (const entry of medicationRequest.entry) {
    let medRef = entry.resource.medicationReference?.reference
    if (medRef) {
      // console.log(`MedicationRequest reference: ${medRef}`)
      const medication = await getFHIRMedication(medRef, accessToken)
      if (medication) {
        medications.push({ resource: medication })
      }
    }
  }
  console.log(`Found ${medications.length} Medication resources`)

  const fhirBundle = {
    resourceType: 'Bundle',
    type: "collection",
    entry: [{ resource: patient },
    ...condition.entry,
    ...observation.entry,
    ...diagnosticReport.entry,
    ...medicationRequest.entry,
    ...medications,
    ...immunization.entry,
    ...allergy.entry,
    ...encounter.entry,
    ...procedure.entry,
    ...device.entry,
    ...deviceRequest.entry,
    ]
  }

  const jsonString = JSON.stringify(fhirBundle, null, 2);
  await saveJsonToFile(jsonString, `va-fhir-data-gen/${patientID}-bundle.json`)
}

async function getFHIRData(resourceType, patientID, accessToken) {
  try {
    var url = resourceType === 'Patient' ? `${fhirEndpoint}/${resourceType}/${patientID}` : `${fhirEndpoint}/${resourceType}?patient=${patientID}`
    if (resourceType === 'Condition') {
      url = url + '&category=http://terminology.hl7.org/CodeSystem/condition-category|problem-list-item'
      url = url + '&clinical-status=http://terminology.hl7.org/CodeSystem/condition-clinical|active'
    }
    if (resourceType === 'MedicationRequest') {
      url = url + '&status=active'
      // BUG: Using VA sandbox, _include does not return Medication in the bundle or as contained.
      // url = url + '&_include=MedicationRequest:medication'
    }
    // console.log(url)
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/fhir+json',
      }
    });

    // console.log(response)
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json(); // Await parsing the JSON body
    // console.log('Success:', result);
    // const jsonString = JSON.stringify(result, null, 2);
    // await saveJsonToFile(jsonString, `test-data/${resourceType}-${patientID}.json`)
    return result;

  } catch (error) {
    console.error('Error:', error);
  }
}

// Returns a FHIR Medication resource
async function getFHIRMedication(medicationReference, accessToken) {
  try {
    const response = await fetch(medicationReference, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/fhir+json',
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    // console.log('Success:', result);
    // const jsonString = JSON.stringify(result, null, 2);
    // await saveJsonToFile(jsonString, `test-data/${resourceType}-${patientID}.json`)
    return result;

  } catch (error) {
    console.error('Error:', error);
  }
}

async function saveJsonToFile(jsonString, fileName) {
  try {
    await fs.writeFileSync(fileName, jsonString, 'utf8');
    console.log(`Data written to ${fileName}`);
  } catch (err) {
    console.error('Error writing file:', err);
  }
}
