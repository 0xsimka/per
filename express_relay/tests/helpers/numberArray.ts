export const convertUint8ArrayNumberArray = (arr: Uint8Array): number[] => {
  let arrLength = arr.length;
  let numberArray: number[] = new Array(arrLength);
  for (let i = 0; i < arrLength; i++) {
    numberArray[i] = arr[i];
  }

  return numberArray;
};
