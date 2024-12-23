/**
 * Garrett Mastin
 * 
 * College Football Bowl Game Prediction Program
 */

/*------------------- .env File Dependencies -----------------*/

require('dotenv').config()

const API_KEY = process.env.API_KEY_CFB
const SHEET_ID_SCORES = process.env.SHEET_ID_SCORES
const SHEET_ID_POLL = process.env.SHEET_ID_POLL

/*-------------------- CFBD Dependencies ---------------------*/

const cfb = require('cfb.js')
const fs = require('fs')

/*---------------- Google Sheets API Dependencies ------------*/

const { google } = require('googleapis')
const service = google.sheets('v4')
const credentials = require('./credentials.json')
  
const authClient = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
)

/*----------------------- SQL Commands -----------------------*/

const sqlite3 = require('sqlite3').verbose()
let dbExists = fs.existsSync('tblScore.db')
let db = new sqlite3.Database('tblScore.db')

if (!dbExists) {
    const CreateTable = `
        CREATE TABLE tblScore (
            timeStamp TEXT PRIMARY KEY UNIQUE,
            firstName TEXT NOT NULL,
            lastName TEXT NOT NULL,
            score INTEGER NOT NULL
        )`

    db.run(CreateTable)
}

/*-------------------------- Main Code -------------------------*/

/**
 * This function uses the Google Sheets API to retrieve all responses from
 * a Google Sheets document containing the poll answers. It then processes the
 * data and writes it to a local JSON file ('answers.json') for further
 * processing.
 *
 * @returns {Promise<void>} resolves once the responses are successfully written to answers.json
 */
async function FetchAnswers() {
    try {

        const token = await authClient.authorize()
        authClient.setCredentials(token)

        const res = await service.spreadsheets.values.get({
            auth: authClient,
            spreadsheetId: SHEET_ID_POLL,
            range: 'A:AN'
        })

        const answersJson = []
        const rows = res.data.values

        if (rows.length) {

            //remove the header rows
            rows.shift()


            for (const row of rows) {
                const userInfo = {
                    timeStamp: row[0],
                    firstName: row[1],
                    lastName: row[2],
                    titleWinner: row[3]
                }

                const gameDetails = {}
                for (let i = 4; i < row.length; i++) {
                    gameDetails['bowlGame' + (i - 3)] = row[i]
                }

                answersJson.push({
                    userInfo,
                    gameDetails
                })
            }
        }

        fs.writeFileSync('answers.json', JSON.stringify(answersJson, null, 2), (err) => {
            if (err) {
                console.error('Error writing answers.json:', err)
            }
        })

    } catch (error) {
        console.error('Error With reading poll results:', error.message)
    }
}

FetchAnswers()

/**
 * This function interacts with the CollegeFootball API to retrieve the results
 * of all postseason games for the specified year. The relevant results are then
 * filtered and written to a local JSON file ('results.json') for further use.
 *
 * @returns {Promise<void>} resolves when the results are successfully written to the 'results.json' file.
 */
async function FetchGames() {
    try {
        const defaultClient = cfb.ApiClient.instance

        const apiKeyAuth = defaultClient.authentications['ApiKeyAuth']
        apiKeyAuth.apiKey = API_KEY

        const apiInstance = new cfb.GamesApi()

        const year = 2024

        const opts = {
            seasonType: 'postseason'
        }

        const GamesWithOpts = await apiInstance.getGames(year, opts)

        const filteredBowlGames = GamesWithOpts.filter((game) =>
                game.notes && !game.notes.includes('College Football Playoff')
        )

        fs.writeFile('results.json', JSON.stringify(filteredBowlGames, null, 2), (err) => {
            if (err) {
                console.error('Error writing results.json:', err)
            }
        })
        
    } catch (error) {
        console.error('Error calling CollegeFootballData API:', error.message)
    }
}

FetchGames()

/**
 * This function reads both the game results (results.json and user predictions,
 * (answers.json) compares them, and assigns points to each user based on how accurate
 * their predictions were. It then updates the local SQLite database and the Google
 * Sheets document with the calculated scores. 
 * 
 * @returns {Promise<void>} resolves when the prediction results are successfully calculated and stored.
 */
async function  FetchPredictionResults() {
    try {
        
        fs.readFile('results.json', 'utf-8', (err, resultsData) => {
            if (err) {
                console.error('Error reading results.json:', err)
                return
            }
            const result = JSON.parse(resultsData)

        fs.readFile('answers.json', 'utf-8', async (err, answersData) => {
            if (err) {
                console.error('Error reading answers.json:', err)
                return
            }
            const answers = JSON.parse(answersData)
    
                let infoForUpdate = []
                const titleWinner = 'Set Equal to Winner'

                // Loops through each user
                for (let currentUser = 0; currentUser < answers.length; currentUser++) {
                    
                    let totalPointsToPlayer = 0

                    if (answers[currentUser].userInfo.titleWinner == titleWinner) {
                        totalPointsToPlayer += 5
                    }

                    const gameDetails = answers[currentUser].gameDetails
                    const gameKeys = Object.keys(gameDetails)  

                    // Loops through each bowl game
                    for (let currentUserChoice = 0; currentUserChoice < gameKeys.length; currentUserChoice++) {
                        
                        const gameKey = gameKeys[currentUserChoice]
                        const userPrediction = gameDetails[gameKey]

                        let correctPrediction = false

                        // Loops through each game result
                        for (let currentGame = 0; currentGame < result.length; currentGame++) {

                            //finds winner of the game
                            if (result[currentGame].homePoints > result[currentGame].awayPoints) {
                                winner = result[currentGame].homeTeam
                            } else if (result[currentGame].homePoints < result[currentGame].awayPoints) {
                                winner = result[currentGame].awayTeam
                            }

                            //checks if the user's prediction is correct
                            if (winner === userPrediction) {
                                correctPrediction = true
                                break
                            }
                        } 

                        //adds points to the user if they predicted the winner correctly
                        if (correctPrediction) {
                            totalPointsToPlayer++
                        }
                    }

                    //makes infoForUpdate an array of arrays with the first name, last name, and total points for each user
                    infoForUpdate.push([
                        answers[currentUser].userInfo.firstName,
                        answers[currentUser].userInfo.lastName,
                        totalPointsToPlayer
                    ])
                    
                    //updates the local SQLite database with the user's score if it already exists, otherwise it inserts the for the first time 
                    if (dbExists) {
                        db.run(`
                            UPDATE tblScore 
                            SET score = ?
                            WHERE firstName = ? AND lastName = ?
                            `,  
                            totalPointsToPlayer, 
                            answers[currentUser].userInfo.firstName, 
                            answers[currentUser].userInfo.lastName
                        )
                        
                    } else {
                        db.run(
                            'INSERT OR IGNORE INTO tblScore (timeStamp, firstName, lastName, score) VALUES (?, ?, ?, ?)',
                            [
                                answers[currentUser].userInfo.timeStamp,
                                answers[currentUser].userInfo.firstName,
                                answers[currentUser].userInfo.lastName,
                                totalPointsToPlayer
                            ]
                        )
                    }
                }
                
                // updates the scores spreadsheet
                await UpdateSheet(infoForUpdate)
            })
        })   
    } catch (error) {
        console.error('Error calulating results:', error.message)
    }
}

 FetchPredictionResults()

/**
 * This function updates the Google Sheets document with the
 * score results of all users.
 *
 * @param {Array<Array<string|number>>} infoForUpdate - An array of arrays where each sub-array
 *  contains the first name (string), last name (string), and score (number) of a user.
 * 
 * @returns {Promise<void>} resolves when the sheet has been updated successfully.
 */
async function UpdateSheet(infoForUpdate) {
    try {

        //takes the array infoForUpdate and sorts based off the totalPointsToPlayer in decending order
        infoForUpdate.sort((currentRow, nextRow) => nextRow[2] - currentRow[2])

        await service.spreadsheets.values.update({
            auth: authClient,
            spreadsheetId: SHEET_ID_SCORES,
            range: 'A2:C', 
            valueInputOption: 'RAW',

            requestBody: {
                values: infoForUpdate
            }
        })

    } catch (error) {
        console.error('Error With updating score spreadsheet:', error.message)
    }
}