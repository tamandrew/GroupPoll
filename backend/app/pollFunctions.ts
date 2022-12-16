import { UserConnection } from "./server";

var ObjectId = require('mongoose').Types.ObjectId;
const Poll = require("./models/pollModel")
const User = require("./models/userModel")

const wsConnections = require("./server")

type Option = {
    optionTitle: string,
    votes: number,
    approved: boolean
}

type VotedFor = {
    userId: string,
    optionIds: [string]
};

const sendUpdatedPoll = async (pollId: string) => {
    console.log(wsConnections)
    const connectedUsers = wsConnections.get(pollId);

    if (connectedUsers) {
        connectedUsers.forEach( async (user: UserConnection) => { //send updated poll to all connected users
            user["ws"].send(await getPoll(user["userId"], pollId))
        });
    }
}

const checkPollId = async (pollId: string) => {
    return ObjectId.isValid(pollId) && await Poll.exists({_id: pollId})
}

const checkUserId = async (userId: string) => {
    return ObjectId.isValid(userId) && await User.exists({_id: userId})
}

const getPoll = async (userId: string, pollId: string) => {
    if (!await checkPollId(pollId)) {
        return JSON.stringify({"error": "Invalid Poll ID"})
    }

    if (!await checkUserId(userId)) {
        return JSON.stringify({"error": "Invalid User ID"})
    }

    var poll = await Poll.findOne({_id: pollId})    
    if (!poll) {
        return JSON.stringify({"error": "Poll expired or Invalid ID."})
    }

    
   

    //check if the user voted before
    if (await Poll.exists({_id: pollId, "votes.userId": userId})) { //check if the poll has an array of votedFor for the user
        const votes = poll["votes"]

        //find the user's ids and get the options they voted for
        var optionsVotedFor = votes.find((vote: VotedFor) => vote["userId"] === userId)["optionIds"]
    } else { //user has never voted before, create new array
        await Poll.updateOne({_id: pollId}, {
            $push: {
                "votes": {
                    userId: userId,
                    optionIds: []
                }
            }
        });
        optionsVotedFor = []
    }

    

    const isOwner = userId === poll["owner"]
    var options = poll["options"]

    if (isOwner) {
        if (poll["hideVotes"] && poll["hideVotesForOwner"])
            options.forEach((option: Option) => option["votes"] = -1) //set -1 to indicate votes hidden

    } else {
        if (poll['approvalRequired'])
            options = options.filter((option: Option) => option["approved"]) //filter out to only show approved options. show all if approval is not required
    
        if (poll['hideVotes']) {
            options.forEach((option: Option) => option["votes"] = -1) //set -1 to indicate votes hidden
        }
    }
        
    return JSON.stringify({
        update: "true",
        pollId: poll["_id"],
        title: poll["title"],
        options: options,
        owner: isOwner,
        settings: {
            limitOneVote: poll["limitOneVote"],
            approvalRequired: poll["approvalRequired"],
            autoApproveOwner: poll["autoApproveOwner"],
            hideVotes: poll["hideVotes"],
            disableVoting: poll["disableVoting"],
            hideVotesForOwner: poll["hideVotesForOwner"],
        },
        votedFor: optionsVotedFor
    })

}

const addOption = async (userId: string, pollId: string, optionTitle: string) => {
    if (optionTitle && await checkPollId(pollId) && await checkUserId(userId)) 
        var poll = await Poll.findOne({_id: pollId})
    else {
        return JSON.stringify({"error" : "Invalid Inputs"})
    }
    
    if (!poll) {
        return JSON.stringify({"error" : "Poll Invalid"})
    }

    await Poll.updateOne({_id: pollId}, {
        $push: {
            options: {
                optionTitle: optionTitle, 
                votes: 0,
                approved: !poll["approvalRequired"] || (poll["autoApproveOwner"] && userId === poll["owner"]) 
            },
        },
    });
    
    sendUpdatedPoll(pollId);
    return JSON.stringify({"success": "Option Added"})
}

const deleteOptions = async (userId: string, pollId: string, optionsToDelete: string[]) => {
    for (let i = 0; i < optionsToDelete.length; i++) {
        if (!ObjectId.isValid(optionsToDelete[i]))
            return JSON.stringify({"error" : "Invalid: " + optionsToDelete[i]})
    }

    if (await checkPollId(pollId) && await checkUserId(userId)) {
        var poll = await Poll.findOne({_id: pollId})
    } else {
        return JSON.stringify({"error": "ID invalid"})
    }


    if (poll && poll["owner"] === userId) {
        await Poll.updateMany({_id: pollId}, {
            $pull: {
               options: {_id: {$in: optionsToDelete}},
            },
        });
        sendUpdatedPoll(pollId);
        return JSON.stringify({"success": "Options Deleted"})
    } else {
        return JSON.stringify({"error": "Permission Denied"})
    }
}    

const approveDenyOption = async (userId: string, pollId: string, optionId: string, approved: boolean) => {
    if (await checkPollId(pollId) && await checkUserId(userId) && ObjectId.isValid(optionId)) {
        var poll = await Poll.findOne({_id: pollId})
    } else {
        return JSON.stringify({"error": "ID invalid"})
    }

    if (poll && poll["owner"] === userId) {
        if (approved) {
            await Poll.updateOne({_id: pollId, "options._id": optionId}, {
                "options.$.approved": true //update to approved
            });
        } else {
            await Poll.updateOne({_id: pollId}, {
                $pull: { //delete the unapproved option
                    options: {_id: optionId},
                },
            });
        }
        
        sendUpdatedPoll(pollId);
        return JSON.stringify({"success": "Option has been " + (approved ? "approved" : "denied")})
    } else {
        return JSON.stringify({"error": "Permission Denied"})
    }
}

const vote = async (userId: string , pollId: string, optionId: string) => {
    if (await checkPollId(pollId) && await checkUserId(userId) && ObjectId.isValid(optionId)) {
        var poll = await Poll.findOne({_id: pollId})
    } else {
        return JSON.stringify({"error": "ID invalid"})
    }
    
    if (!poll || poll["disableVoting"]) {
        return JSON.stringify({"error": "No Voting Allowed"})
    }

    const limitOneVote = poll["limitOneVote"];
    const ids = poll["votes"]
    
    try {
        var optionIds = ids.find((vote: VotedFor) => vote["userId"] === userId)["optionIds"] //get array of optionIds user has voted for
    } catch (error) {
        return JSON.stringify({"error": "Invalid ID"})
    }
    
    if (optionIds.includes(optionId)) { //vote found, remove it
        await Poll.updateOne({_id: pollId, "votes.userId": userId}, {
            $pull: { //remove vote
                "votes.$.optionIds": optionId
            }
        });
        change = -1;
    } else { //vote not found, add it
        if (limitOneVote && optionIds.length >= 1) {
            return JSON.stringify({"error": "Limit One Vote"})
        } else {
            //    votes: [{userId: String, optionIds: [String]}],
            await Poll.updateOne({_id: pollId, "votes.userId": userId}, {
                $push: { //add vote
                    "votes.$.optionIds": optionId
                }
            });
            var change = 1; //num to change vote count by
        }
    }


    //    options: [{ optionTitle: String, votes: Number}],
    await Poll.updateOne({_id: pollId, "options._id": optionId}, {
        $inc: {
            "options.$.votes": change //update vote count
        },
    });
    
    sendUpdatedPoll(pollId)
    return JSON.stringify({"success": "Vote Acknowledged"})
    
}

const updateSetting = async (userId: string, pollId: string, setting: string, newValue: boolean) => {   
    if (await checkPollId(pollId) && await checkUserId(userId))  
        var poll = await Poll.findOne({_id: pollId})
    else {
        return JSON.stringify({"error" : "Invalid Inputs"})
    }

    if (!poll || poll["owner"] !== userId) {
        return JSON.stringify({"error" : "Permission Denied"})
    }

    type SettingUpdate = {limitOneVote: boolean} | {approvalRequired: boolean} | {hideVotes: boolean} | {hideVotesForOwner: boolean} | {disableVoting: boolean} | {autoApproveOwner: boolean}
    
    switch (setting) {
        case "limitOneVote":
            var update : SettingUpdate = { limitOneVote: newValue }; 
            break;
        case "approvalRequired":
            update = { approvalRequired: newValue };
            break;
        case "hideVotes":
            update = { hideVotes: newValue };
            break;
        case "hideVotesForOwner":
            update = { hideVotesForOwner: newValue };
            break;
        case "disableVoting":
            update = { disableVoting: newValue };
            break;
        case "autoApproveOwner":
            update = {autoApproveOwner: newValue};
            break;
        default:
            return JSON.stringify({"error" : "Invalid Setting: " + setting})
    }

    await Poll.updateOne({_id: pollId}, update);

    sendUpdatedPoll(pollId)
    return JSON.stringify({"success": setting + " Updated"})
}

module.exports = {getPoll, addOption, sendUpdatedPoll, deleteOptions, approveDenyOption, vote, updateSetting}